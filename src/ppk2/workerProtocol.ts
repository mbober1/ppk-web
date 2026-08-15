/**
 * Message contract between the main thread (client.ts) and the parser
 * worker (worker.ts).
 *
 * The main thread owns the SerialPort (it cannot be transferred to a worker —
 * SerialPort is not Transferable and not structured-cloneable). The main
 * thread does all serial I/O and forwards raw byte chunks to the worker,
 * which handles metadata parsing, sample decoding, calibration, and batching.
 */

export type MainToWorker =
  | { type: "reset"; requestId: number }
  | { type: "metadataBytes"; chunk: Uint8Array; requestId: number }
  | { type: "setVdd"; mv: number; requestId: number }
  | { type: "startSampling"; requestId: number }
  | { type: "stopSampling"; requestId: number }
  // n = number of raw 100 kHz samples averaged into one output sample.
  // Must be applied before startSampling.
  | { type: "setDecimation"; n: number; requestId: number }
  // Fire-and-forget: no requestId, no ack. The hot path must not incur
  // a round-trip per chunk or the read loop stalls behind postMessage.
  | { type: "sampleBytes"; chunk: Uint8Array };

export type WorkerToMain =
  | { type: "ack"; requestId: number; ok: true }
  | { type: "ack"; requestId: number; ok: false; error: string }
  | {
      type: "samples";
      current: Float32Array;
      digital: Uint8Array;
      /** First-sample monotonic timestamp in microseconds since sampling started. */
      startTsUs: number;
      /** Effective (post-decimation) output sample rate in Hz. */
      sampleRateHz: number;
    }
  | { type: "error"; message: string };
