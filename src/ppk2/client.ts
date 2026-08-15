/**
 * Main-thread facade for the PPK2.
 *
 * Owns the SerialPort (SerialPort is not Transferable and cannot be passed
 * to a worker), runs the read/write loops, and forwards raw byte chunks to
 * the parser worker. The worker decodes sample frames off the UI thread and
 * posts back typed-array batches.
 */

import {
  buildGetMetadata,
  buildSetPowerMode,
  buildSetVoltage,
  buildSpikeFilter,
  buildStart,
  buildStop,
  buildToggleDut,
  decimationForRate,
  DEFAULT_SAMPLE_RATE_HZ,
  PPK2_USB_FILTER,
  type PowerMode,
} from "./protocol";
import type { MainToWorker, WorkerToMain } from "./workerProtocol";

export interface SampleBatch {
  current: Float32Array;
  digital: Uint8Array;
  /** Timestamp of first sample in microseconds since sampling started. */
  startTsUs: number;
  /** Effective (post-decimation) output sample rate for this batch, in Hz. */
  sampleRateHz: number;
}

export interface StatusEvent {
  connected: boolean;
  sampling: boolean;
}

type SampleListener = (batch: SampleBatch) => void;
type StatusListener = (status: StatusEvent) => void;
type ErrorListener = (message: string) => void;

const METADATA_TIMEOUT_MS = 2000;

export class Ppk2Client {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private pending = new Map<
    number,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  private sampleListeners = new Set<SampleListener>();
  private statusListeners = new Set<StatusListener>();
  private errorListeners = new Set<ErrorListener>();
  private status: StatusEvent = { connected: false, sampling: false };

  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopPromise: Promise<void> | null = null;
  private sampling = false;
  private sampleRateHz: number = DEFAULT_SAMPLE_RATE_HZ;

  /** Returns true when the browser exposes Web Serial. */
  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  getStatus(): StatusEvent {
    return this.status;
  }

  onSamples(cb: SampleListener): () => void {
    this.sampleListeners.add(cb);
    return () => this.sampleListeners.delete(cb);
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  onError(cb: ErrorListener): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  /**
   * Prompts the user for a PPK2 port (filtered to Nordic VID/PID), opens
   * it on the main thread, and fetches calibration metadata via the worker.
   */
  async connect(): Promise<void> {
    if (!Ppk2Client.isSupported()) {
      throw new Error(
        "Web Serial is not supported in this browser. Use Chrome or Edge.",
      );
    }
    if (this.port) {
      throw new Error("Already connected");
    }

    const port = await navigator.serial.requestPort({
      filters: [PPK2_USB_FILTER],
    });
    // Baud rate is irrelevant for USB CDC-ACM but the API requires a value.
    await port.open({ baudRate: 9600 });
    if (!port.readable || !port.writable) {
      await port.close().catch(() => undefined);
      throw new Error("Serial port streams unavailable");
    }
    this.port = port;
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();

    this.ensureWorker();
    await this.send({ type: "reset", requestId: 0 });

    try {
      // Drain any residual bytes from a previous session.
      await this.drainReader(100);
      // Request metadata and stream it into the worker until it reports
      // parsed calibration (or we time out).
      await this.writeBytes(buildGetMetadata());
      await this.readMetadataInto(METADATA_TIMEOUT_MS);
    } catch (err) {
      await this.teardownPort();
      throw err;
    }

    this.setStatus({ connected: true, sampling: false });
  }

  async disconnect(): Promise<void> {
    if (!this.port) return;
    this.sampling = false;
    try {
      await this.writeBytes(buildStop());
    } catch {
      /* ignore */
    }
    await this.teardownPort();
    this.setStatus({ connected: false, sampling: false });
  }

  async setVoltage(mv: number): Promise<void> {
    await this.writeBytes(buildSetVoltage(mv));
    await this.send({ type: "setVdd", mv, requestId: 0 });
  }

  async setMode(mode: PowerMode): Promise<void> {
    await this.writeBytes(buildSetPowerMode(mode));
  }

  async setDut(on: boolean): Promise<void> {
    await this.writeBytes(buildToggleDut(on));
  }

  async setSpikeFilter(on: boolean): Promise<void> {
    await this.writeBytes(buildSpikeFilter(on));
  }

  /**
   * Set the effective output sample rate in Hz. Achieved by averaging N
   * consecutive raw 100 kHz samples in the parser worker (there is no
   * hardware command for this — the PPK2 ADC is fixed at 100 kSa/s).
   *
   * Must be called while not sampling; changing rate mid-recording would
   * produce a mixed-rate stream that the recorder can't reconstruct.
   */
  async setSampleRate(hz: number): Promise<void> {
    if (this.sampling) throw new Error("Stop sampling before changing rate");
    const n = decimationForRate(hz);
    this.sampleRateHz = hz;
    this.ensureWorker();
    await this.send({ type: "setDecimation", n, requestId: 0 });
  }

  getSampleRate(): number {
    return this.sampleRateHz;
  }

  async start(): Promise<void> {
    if (!this.port) throw new Error("Not connected");
    if (this.sampling) return;
    await this.send({ type: "startSampling", requestId: 0 });
    await this.writeBytes(buildStart());
    this.sampling = true;
    this.setStatus({ connected: true, sampling: true });
    this.readLoopPromise = this.sampleReadLoop().catch((err) => {
      this.emitError(`Read loop failed: ${String(err)}`);
    });
  }

  async stop(): Promise<void> {
    if (!this.sampling) return;
    this.sampling = false;
    try {
      await this.writeBytes(buildStop());
    } catch {
      /* ignore */
    }
    await this.readLoopPromise?.catch(() => undefined);
    this.readLoopPromise = null;
    await this.send({ type: "stopSampling", requestId: 0 });
    this.setStatus({ connected: this.port !== null, sampling: false });
  }

  // -- internals --------------------------------------------------------------

  private ensureWorker(): void {
    if (this.worker) return;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "ppk2-parser",
    });
    this.worker.onmessage = (ev: MessageEvent<WorkerToMain>) =>
      this.handleWorkerMessage(ev.data);
    this.worker.onerror = (ev) => {
      this.emitError(ev.message || "Worker error");
    };
  }

  private handleWorkerMessage(msg: WorkerToMain): void {
    switch (msg.type) {
      case "ack": {
        const pending = this.pending.get(msg.requestId);
        if (!pending) return;
        this.pending.delete(msg.requestId);
        if (msg.ok) pending.resolve();
        else pending.reject(new Error(msg.error));
        break;
      }
      case "samples":
        for (const cb of this.sampleListeners) {
          cb({
            current: msg.current,
            digital: msg.digital,
            startTsUs: msg.startTsUs,
            sampleRateHz: msg.sampleRateHz,
          });
        }
        break;
      case "error":
        this.emitError(msg.message);
        break;
    }
  }

  private send(
    msg: MainToWorker,
    transfer: Transferable[] = [],
  ): Promise<void> {
    this.ensureWorker();
    const requestId = this.nextRequestId++;
    const withId = { ...msg, requestId } as MainToWorker;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker!.postMessage(withId, transfer);
    });
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("Serial port not attached");
    await this.writer.write(bytes);
  }

  private async drainReader(timeoutMs: number): Promise<void> {
    if (!this.reader) return;
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const race = await Promise.race([
        this.reader.read(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20)),
      ]);
      if (race === "timeout") return;
      if (race.done) return;
      // discard bytes
    }
  }

  /**
   * Read serial bytes and forward them to the worker until the worker has
   * parsed metadata (signaled by our request/ack) or the timeout elapses.
   *
   * The worker parses metadata itself and only acks 'metadataBytes' after
   * each chunk; we detect the terminator ('END') on the raw stream here so
   * we know when to stop reading.
   */
  private async readMetadataInto(timeoutMs: number): Promise<void> {
    if (!this.reader) throw new Error("Reader not available");
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let text = "";
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const race = await Promise.race([
        this.reader.read(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 200)),
      ]);
      if (race === "timeout") break;
      if (race.done) break;
      const value = race.value;
      if (!value || value.length === 0) continue;
      text += decoder.decode(value, { stream: true });
      // Copy into a fresh buffer we can transfer to the worker.
      const chunk = new Uint8Array(value);
      await this.send({ type: "metadataBytes", chunk, requestId: 0 }, [
        chunk.buffer,
      ]);
      if (text.includes("END")) return;
    }
    if (!text) throw new Error("No metadata received from PPK2");
  }

  private async sampleReadLoop(): Promise<void> {
    if (!this.reader) return;
    const worker = this.worker!;
    while (this.sampling) {
      const { value, done } = await this.reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      // The Uint8Array returned by Web Serial's default reader is owned
      // by us (each read() yields a fresh buffer), so we can transfer
      // its underlying ArrayBuffer directly to the worker without a
      // copy. Fire-and-forget: no ack, no await -> no serialization
      // of the read loop.
      worker.postMessage({ type: "sampleBytes", chunk: value }, [value.buffer]);
    }
  }

  private async teardownPort(): Promise<void> {
    try {
      this.reader?.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await this.port?.close();
    } catch {
      /* ignore */
    }
    this.reader = null;
    this.writer = null;
    this.port = null;
  }

  private setStatus(next: StatusEvent): void {
    this.status = next;
    for (const cb of this.statusListeners) cb(this.status);
  }

  private emitError(message: string): void {
    for (const cb of this.errorListeners) cb(message);
  }
}

export const ppk2 = new Ppk2Client();
