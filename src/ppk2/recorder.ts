/**
 * In-memory recorder for sample batches.
 *
 * Grows a chunked Float32Array/Uint8Array pair so we don't reallocate a
 * 100 MB buffer every second. Chunks are 1 s of samples (100k samples =
 * 400 kB current + 100 kB digital). Recording is capped at MAX_MINUTES to
 * avoid tab OOM; the older data is dropped in FIFO order when full.
 *
 * The live stats (avg/min/max/charge) are accumulated incrementally so the
 * UI never has to walk the full history.
 */

import { DEFAULT_SAMPLE_RATE_HZ } from "./protocol";
import type { SampleBatch } from "./client";

/**
 * Fixed RAM budget for retained samples (current + digital).
 *   Float32 current = 4 B, Uint8 digital = 1 B → 5 B/sample.
 * At 100 M samples this is ~500 MB, which is roughly the largest allocation
 * a modern desktop browser will tolerate without tab crashes. Adjust down
 * for lower-memory environments.
 */
const MAX_SAMPLES = 100_000_000;

/** Target chunk length in seconds; the actual sample count scales with rate. */
const CHUNK_SECONDS = 1;
/** Minimum chunk size in samples to avoid pathological chunk counts at 1 Hz. */
const MIN_CHUNK_SAMPLES = 1024;

export interface Stats {
  samples: number;
  avgUa: number;
  minUa: number;
  maxUa: number;
  chargeUc: number; // integrated μA·s = μC
  durationS: number;
}

export function emptyStats(): Stats {
  return {
    samples: 0,
    avgUa: 0,
    minUa: 0,
    maxUa: 0,
    chargeUc: 0,
    durationS: 0,
  };
}

interface Chunk {
  current: Float32Array;
  digital: Uint8Array;
  filled: number;
}

export class Recorder {
  private chunks: Chunk[] = [];
  private stats: Stats = emptyStats();
  private sum = 0;
  private sampleRateHz: number = DEFAULT_SAMPLE_RATE_HZ;
  private chunkSamples: number = Math.max(
    MIN_CHUNK_SAMPLES,
    DEFAULT_SAMPLE_RATE_HZ * CHUNK_SECONDS,
  );
  private maxChunks: number = Math.max(
    1,
    Math.ceil(MAX_SAMPLES / this.chunkSamples),
  );

  reset(): void {
    this.chunks = [];
    this.stats = emptyStats();
    this.sum = 0;
  }

  /**
   * Set the sample rate used for time-domain calculations (durationS,
   * chunk sizing). Silently ignored if it equals the current rate. Should
   * be called between recordings — a rate change while data is retained
   * would break time-index math for older chunks.
   */
  setSampleRate(hz: number): void {
    if (hz === this.sampleRateHz) return;
    this.sampleRateHz = hz;
    this.chunkSamples = Math.max(
      MIN_CHUNK_SAMPLES,
      Math.round(hz * CHUNK_SECONDS),
    );
    this.maxChunks = Math.max(1, Math.ceil(MAX_SAMPLES / this.chunkSamples));
    this.reset();
  }

  getSampleRate(): number {
    return this.sampleRateHz;
  }

  /** Maximum retainable recording duration in seconds at the current rate. */
  get maxDurationS(): number {
    return MAX_SAMPLES / this.sampleRateHz;
  }

  getStats(): Stats {
    return this.stats;
  }

  /** Total number of samples currently retained. */
  get sampleCount(): number {
    return this.stats.samples;
  }

  /** Append a batch of samples. */
  append(batch: SampleBatch): void {
    // Compute min/max/sum over the full batch once (hoisted refs, tight
    // loop -> V8 turbofans this to SIMD-ish speed). Doing it here rather
    // than per-slice inside the copy loop avoids repeatedly loading
    // stats.min/max from the heap.
    const src = batch.current;
    const n = src.length;
    let bMin = Infinity;
    let bMax = -Infinity;
    let bSum = 0;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (v < bMin) bMin = v;
      if (v > bMax) bMax = v;
      bSum += v;
    }

    if (this.stats.samples === 0) {
      this.stats.minUa = bMin;
      this.stats.maxUa = bMax;
    } else {
      if (bMin < this.stats.minUa) this.stats.minUa = bMin;
      if (bMax > this.stats.maxUa) this.stats.maxUa = bMax;
    }
    this.sum += bSum;

    // Copy into chunked storage.
    const chunkSize = this.chunkSamples;
    let off = 0;
    while (off < n) {
      const chunk = this.tailChunk();
      const space = chunkSize - chunk.filled;
      const take = Math.min(space, n - off);
      chunk.current.set(src.subarray(off, off + take), chunk.filled);
      chunk.digital.set(batch.digital.subarray(off, off + take), chunk.filled);
      chunk.filled += take;
      off += take;
    }
    this.stats.samples += n;
    this.stats.avgUa = this.sum / this.stats.samples;
    this.stats.durationS = this.stats.samples / this.sampleRateHz;
    // Charge (μC) = avg μA * seconds
    this.stats.chargeUc = this.stats.avgUa * this.stats.durationS;
  }

  /**
   * Produce a min/max down-sampled view of a range of the recording.
   *
   * For each of `bins` output pixels, walks the samples that map to that
   * pixel and records the min and max. This lets us render an entire
   * multi-minute recording into a chart of ~2000 pixels without ever
   * materialising the full sample array — the alternative (snapshotting
   * everything and letting the chart decimate) is what turns 30 min ×
   * 100 kHz into an OOM / jank fest.
   *
   * When the range is smaller than `bins` samples, `min === max` for every
   * pixel and the caller gets back essentially the raw signal.
   *
   * @param startIdx  Absolute sample index (inclusive) of the visible window.
   * @param endIdx    Absolute sample index (exclusive).
   * @param bins      Desired number of output pixels/columns.
   * @param outMin    Pre-allocated Float32Array of length ≥ `bins`.
   * @param outMax    Pre-allocated Float32Array of length ≥ `bins`.
   * @returns Number of bins actually populated (== bins when range > 0).
   */
  sliceMinMax(
    startIdx: number,
    endIdx: number,
    bins: number,
    outMin: Float32Array,
    outMax: Float32Array,
  ): number {
    const totalSamples = this.stats.samples;
    if (bins <= 0 || endIdx <= startIdx || totalSamples === 0) return 0;

    // Clamp to available range.
    const s = Math.max(0, Math.min(totalSamples, startIdx));
    const e = Math.max(s, Math.min(totalSamples, endIdx));
    const rangeLen = e - s;
    if (rangeLen === 0) return 0;

    // Number of samples per output bin (may be fractional).
    const step = rangeLen / bins;

    // Walk chunks to find where sample index `s` lives. Each chunk holds
    // CHUNK_SAMPLES samples in absolute order (chunks[0] starts at absolute
    // index this.stats.samples - sum(chunk.filled)).
    let baseIdx = 0;
    for (const c of this.chunks) baseIdx += c.filled;
    baseIdx = totalSamples - baseIdx; // absolute start index of chunks[0]

    // Fast path: single-pass sweep. We advance a running pointer through
    // (chunkIndex, offsetInChunk) and, for each bin, compute [binStart,binEnd)
    // in absolute indices and consume that many samples.
    let chunkIdx = 0;
    let absPos = baseIdx;
    // Advance to the chunk containing sample `s`.
    while (
      chunkIdx < this.chunks.length &&
      absPos + this.chunks[chunkIdx].filled <= s
    ) {
      absPos += this.chunks[chunkIdx].filled;
      chunkIdx++;
    }
    let inChunkOff = s - absPos;

    for (let b = 0; b < bins; b++) {
      const binStart = s + Math.floor(b * step);
      let binEnd = s + Math.floor((b + 1) * step);
      if (b === bins - 1) binEnd = e; // include tail
      if (binEnd <= binStart) {
        // Ensure at least 1 sample per bin so we never emit NaN.
        binEnd = Math.min(e, binStart + 1);
      }
      let need = binEnd - binStart;

      let bMin = Infinity;
      let bMax = -Infinity;

      while (need > 0 && chunkIdx < this.chunks.length) {
        const chunk = this.chunks[chunkIdx];
        const available = chunk.filled - inChunkOff;
        if (available <= 0) {
          chunkIdx++;
          inChunkOff = 0;
          continue;
        }
        const take = need < available ? need : available;
        const arr = chunk.current;
        const end = inChunkOff + take;
        for (let i = inChunkOff; i < end; i++) {
          const v = arr[i];
          if (v < bMin) bMin = v;
          if (v > bMax) bMax = v;
        }
        inChunkOff += take;
        need -= take;
        if (inChunkOff >= chunk.filled) {
          chunkIdx++;
          inChunkOff = 0;
        }
      }

      if (bMin === Infinity) {
        // Should only happen if we ran off the end.
        bMin = 0;
        bMax = 0;
      }
      outMin[b] = bMin;
      outMax[b] = bMax;
    }

    return bins;
  }

  /**
   * Absolute sample index of the oldest retained sample. Non-zero once the
   * FIFO cap has kicked in (older chunks were dropped).
   */
  get oldestSampleIdx(): number {
    let retained = 0;
    for (const c of this.chunks) retained += c.filled;
    return this.stats.samples - retained;
  }

  /** Copy all recorded current samples into a single contiguous Float32Array. */
  snapshotCurrent(): Float32Array {
    const out = new Float32Array(this.stats.samples);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c.current.subarray(0, c.filled), off);
      off += c.filled;
    }
    return out;
  }

  /** Copy all recorded digital samples into a single contiguous Uint8Array. */
  snapshotDigital(): Uint8Array {
    const out = new Uint8Array(this.stats.samples);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c.digital.subarray(0, c.filled), off);
      off += c.filled;
    }
    return out;
  }

  private tailChunk(): Chunk {
    const chunkSize = this.chunkSamples;
    const last = this.chunks[this.chunks.length - 1];
    if (last && last.filled < chunkSize) return last;
    const chunk: Chunk = {
      current: new Float32Array(chunkSize),
      digital: new Uint8Array(chunkSize),
      filled: 0,
    };
    this.chunks.push(chunk);
    // Rolling window: drop the oldest chunk once we exceed the cap.
    if (this.chunks.length > this.maxChunks) {
      const dropped = this.chunks.shift()!;
      this.stats.samples -= dropped.filled;
      // Note: min/max are not re-computed when we drop data; they stay
      // as historical extremes. Avg drifts slightly, which is acceptable
      // for a long rolling window. We approximate by scaling sum.
      this.sum = this.stats.avgUa * this.stats.samples;
    }
    return chunk;
  }
}
