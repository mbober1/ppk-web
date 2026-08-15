/**
 * PPK2 parser worker.
 *
 * The main thread owns the SerialPort (SerialPort is not Transferable, so
 * it cannot be moved into a worker). This worker exists purely to keep the
 * hot decoding path off the UI thread: it receives raw byte chunks from the
 * main thread, decodes sample frames into typed arrays via sampleParser, and
 * transfers batches back.
 */

/// <reference lib="webworker" />

import { NATIVE_SAMPLE_RATE_HZ } from "./protocol";
import { defaultModifiers, parseMetadata, type Modifiers } from "./modifiers";
import { newParserState, parseChunk, type ParserState } from "./sampleParser";
import type { MainToWorker, WorkerToMain } from "./workerProtocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// A batch size of ~4096 output samples strikes a balance between chart update
// rate and postMessage overhead. With decimation the flush interval scales
// with 1/rate — at 1 kHz a 4096-sample batch is ~4 seconds, so we also cap
// the maximum wall-clock time between flushes below.
const BATCH_SAMPLES = 4096;
const MAX_BATCH_INTERVAL_MS = 100;

interface State {
  modifiers: Modifiers;
  parser: ParserState;
  vddV: number;
  sampling: boolean;
  leftover: Uint8Array;
  /** Absolute count of raw (pre-decimation) samples ingested. */
  rawSampleCount: number;
  /** Absolute count of output (post-decimation) samples produced. */
  outputSampleCount: number;
  /** Timestamp (performance.now * 1000) at which sampling started. */
  startTimeUs: number;
  metadataText: string;
  currentBuf: Float32Array;
  digitalBuf: Uint8Array;
  filled: number;
  batchStartSampleIdx: number;
  lastFlushMs: number;

  // Decimation state. `decimation` is how many raw samples fold into one
  // output sample. `decAcc` accumulates a running sum across chunks so we
  // don't lose partial groups at chunk boundaries.
  decimation: number;
  decAcc: number;
  decCount: number;
  decDigital: number;
  // Raw-sample scratch buffer sized to hold one worst-case parseChunk output.
  rawCurrent: Float32Array;
  rawDigital: Uint8Array;
}

const state: State = {
  modifiers: defaultModifiers(),
  parser: newParserState(),
  vddV: 3.3,
  sampling: false,
  leftover: new Uint8Array(0),
  rawSampleCount: 0,
  outputSampleCount: 0,
  startTimeUs: 0,
  metadataText: "",
  currentBuf: new Float32Array(BATCH_SAMPLES),
  digitalBuf: new Uint8Array(BATCH_SAMPLES),
  filled: 0,
  batchStartSampleIdx: 0,
  lastFlushMs: 0,
  decimation: 1,
  decAcc: 0,
  decCount: 0,
  decDigital: 0,
  // Grows on demand.
  rawCurrent: new Float32Array(BATCH_SAMPLES),
  rawDigital: new Uint8Array(BATCH_SAMPLES),
};

/** Output rate in Hz given current decimation. */
function outputRateHz(): number {
  return NATIVE_SAMPLE_RATE_HZ / Math.max(1, state.decimation);
}

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function resetAll(): void {
  state.parser = newParserState();
  state.leftover = new Uint8Array(0);
  state.rawSampleCount = 0;
  state.outputSampleCount = 0;
  state.sampling = false;
  state.metadataText = "";
  state.currentBuf = new Float32Array(BATCH_SAMPLES);
  state.digitalBuf = new Uint8Array(BATCH_SAMPLES);
  state.filled = 0;
  state.batchStartSampleIdx = 0;
  state.modifiers = defaultModifiers();
  state.decAcc = 0;
  state.decCount = 0;
  state.decDigital = 0;
}

function startSampling(): void {
  state.parser = newParserState();
  state.leftover = new Uint8Array(0);
  state.rawSampleCount = 0;
  state.outputSampleCount = 0;
  state.filled = 0;
  state.batchStartSampleIdx = 0;
  state.currentBuf = new Float32Array(BATCH_SAMPLES);
  state.digitalBuf = new Uint8Array(BATCH_SAMPLES);
  state.startTimeUs = Math.floor(performance.now() * 1000);
  state.lastFlushMs = performance.now();
  state.decAcc = 0;
  state.decCount = 0;
  state.decDigital = 0;
  state.sampling = true;
}

function stopSampling(): void {
  if (!state.sampling) return;
  state.sampling = false;
  // Emit any partial decimation group as one final output sample so no data
  // is dropped at the tail.
  if (state.decCount > 0 && state.decimation > 1) {
    appendOutputSample(state.decAcc / state.decCount, state.decDigital);
    state.decAcc = 0;
    state.decCount = 0;
    state.decDigital = 0;
  }
  if (state.filled > 0) flushBatch();
}

/** Append one *output* sample (already decimated) to the current batch. */
function appendOutputSample(current: number, digital: number): void {
  if (state.filled >= state.currentBuf.length) {
    // Grow batch buffers if we somehow accumulated more than one batch's
    // worth without flushing.
    const grown = state.currentBuf.length * 2;
    const nc = new Float32Array(grown);
    nc.set(state.currentBuf.subarray(0, state.filled));
    state.currentBuf = nc;
    const nd = new Uint8Array(grown);
    nd.set(state.digitalBuf.subarray(0, state.filled));
    state.digitalBuf = nd;
  }
  state.currentBuf[state.filled] = current;
  state.digitalBuf[state.filled] = digital;
  state.filled++;
  state.outputSampleCount++;
}

function ingestSampleBytes(chunk: Uint8Array): void {
  if (!state.sampling || chunk.length === 0) return;

  // Ensure the raw scratch buffer can hold everything parseChunk might emit.
  const maxNewRaw = Math.floor((state.leftover.length + chunk.length) / 4);
  if (state.rawCurrent.length < maxNewRaw) {
    const size = Math.max(state.rawCurrent.length * 2, maxNewRaw);
    state.rawCurrent = new Float32Array(size);
    state.rawDigital = new Uint8Array(size);
  }

  const { produced, leftover } = parseChunk(
    chunk,
    state.leftover,
    state.parser,
    state.modifiers,
    state.vddV,
    state.rawCurrent,
    state.rawDigital,
  );
  state.leftover = leftover;
  state.rawSampleCount += produced;

  // Decimate: fold `state.decimation` raw samples into one output sample.
  // decAcc / decCount / decDigital carry over across chunks so a group can
  // straddle a chunk boundary without loss.
  const N = state.decimation;
  if (N <= 1) {
    // Fast path: no decimation, just copy raw -> output batch buffer.
    let space = state.currentBuf.length - state.filled;
    let copied = 0;
    while (copied < produced) {
      if (space === 0) {
        // Grow if needed (rare).
        const grown = state.currentBuf.length * 2;
        const nc = new Float32Array(grown);
        nc.set(state.currentBuf.subarray(0, state.filled));
        state.currentBuf = nc;
        const nd = new Uint8Array(grown);
        nd.set(state.digitalBuf.subarray(0, state.filled));
        state.digitalBuf = nd;
        space = state.currentBuf.length - state.filled;
      }
      const take = Math.min(space, produced - copied);
      state.currentBuf.set(
        state.rawCurrent.subarray(copied, copied + take),
        state.filled,
      );
      state.digitalBuf.set(
        state.rawDigital.subarray(copied, copied + take),
        state.filled,
      );
      state.filled += take;
      state.outputSampleCount += take;
      copied += take;
      space -= take;
    }
  } else {
    let acc = state.decAcc;
    let count = state.decCount;
    let digital = state.decDigital;
    const raw = state.rawCurrent;
    const rawD = state.rawDigital;
    for (let i = 0; i < produced; i++) {
      // Preserve the digital state of the first sample of each group.
      if (count === 0) digital = rawD[i];
      acc += raw[i];
      count++;
      if (count >= N) {
        appendOutputSample(acc / N, digital);
        acc = 0;
        count = 0;
        digital = 0;
      }
    }
    state.decAcc = acc;
    state.decCount = count;
    state.decDigital = digital;
  }

  // Flush either when the batch fills up, or at a fixed wall-clock cadence
  // (so low sample rates still update the UI in a timely manner).
  const now = performance.now();
  if (
    state.filled >= BATCH_SAMPLES ||
    (state.filled > 0 && now - state.lastFlushMs >= MAX_BATCH_INTERVAL_MS)
  ) {
    flushBatch();
    state.lastFlushMs = now;
  }
}

function flushBatch(): void {
  // Trim to the exact number of samples produced. `slice` copies into a
  // fresh backing buffer that we can then transfer.
  const current = state.currentBuf.slice(0, state.filled);
  const digital = state.digitalBuf.slice(0, state.filled);
  const rate = outputRateHz();
  const startTsUs =
    state.startTimeUs +
    Math.floor((state.batchStartSampleIdx * 1_000_000) / rate);
  post({ type: "samples", current, digital, startTsUs, sampleRateHz: rate }, [
    current.buffer,
    digital.buffer,
  ]);
  state.batchStartSampleIdx = state.outputSampleCount;
  state.filled = 0;
  state.currentBuf = new Float32Array(BATCH_SAMPLES);
  state.digitalBuf = new Uint8Array(BATCH_SAMPLES);
}

function ingestMetadataBytes(chunk: Uint8Array): void {
  // Metadata is ASCII/UTF-8 text terminated by 'END'.
  state.metadataText += new TextDecoder("utf-8", { fatal: false }).decode(
    chunk,
  );
  if (state.metadataText.includes("END")) {
    try {
      state.modifiers = parseMetadata(state.metadataText);
    } catch (err) {
      post({
        type: "error",
        message: `Failed to parse PPK2 metadata: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    state.metadataText = "";
  }
}

ctx.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case "reset":
        resetAll();
        post({ type: "ack", requestId: msg.requestId, ok: true });
        break;
      case "metadataBytes":
        ingestMetadataBytes(msg.chunk);
        post({ type: "ack", requestId: msg.requestId, ok: true });
        break;
      case "setVdd":
        state.vddV = msg.mv / 1000;
        post({ type: "ack", requestId: msg.requestId, ok: true });
        break;
      case "startSampling":
        startSampling();
        post({ type: "ack", requestId: msg.requestId, ok: true });
        break;
      case "stopSampling":
        stopSampling();
        post({ type: "ack", requestId: msg.requestId, ok: true });
        break;
      case "setDecimation":
        state.decimation = Math.max(1, Math.floor(msg.n));
        // Drop any partial accumulator — a rate change mid-stream is
        // treated as a hard boundary. In practice the client blocks this
        // while sampling is active.
        state.decAcc = 0;
        state.decCount = 0;
        state.decDigital = 0;
        post({ type: "ack", requestId: msg.requestId, ok: true });
        break;
      case "sampleBytes":
        // Fire-and-forget: no ack (see workerProtocol.ts).
        ingestSampleBytes(msg.chunk);
        break;
    }
  } catch (err) {
    // Only request-bearing messages can be acked with the error.
    if ("requestId" in msg) {
      post({
        type: "ack",
        requestId: msg.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } else {
      post({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
