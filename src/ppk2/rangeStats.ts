/**
 * Statistics (avg/min/max/charge/duration) over an arbitrary sample range,
 * used by the chart's shift-drag selection feature.
 *
 * Mirrors the shape of `decimateMinMaxRange` in `decimate.ts` (plain
 * function over a `Float32Array` + `startIdx`/`endIdx`/`rateHz`), so it
 * works on both a loaded snapshot's raw array and (in principle) any other
 * contiguous µA buffer.
 *
 * `maxSamples` lets callers trade accuracy for speed while a drag is in
 * progress: when the range spans more samples than the budget, the walk is
 * strided (approximate min/max/avg). `durationS` and `chargeUc` are always
 * computed from the full sample count so they stay first-frame-accurate;
 * only avg/min/max are approximated. Pass `Infinity` (the default) for an
 * exact pass, e.g. once the drag ends.
 */

import { emptyStats, type Stats } from "./recorder";

export function rangeStats(
  src: Float32Array,
  startIdx: number,
  endIdx: number,
  rateHz: number,
  maxSamples: number = Infinity,
): Stats {
  const from = Math.max(0, Math.floor(startIdx));
  const to = Math.min(src.length, Math.ceil(endIdx));
  const n = to - from;
  if (n <= 0 || rateHz <= 0) return emptyStats();

  const stride = n > maxSamples ? Math.ceil(n / maxSamples) : 1;

  let sum = 0;
  let count = 0;
  let minUa = src[from];
  let maxUa = src[from];
  for (let i = from; i < to; i += stride) {
    const v = src[i];
    sum += v;
    count++;
    if (v < minUa) minUa = v;
    if (v > maxUa) maxUa = v;
  }

  const avgUa = sum / count;
  const durationS = n / rateHz;
  // integrated μA·s = μC — same identity used by Recorder.append().
  const chargeUc = avgUa * durationS;

  return {
    samples: n,
    avgUa,
    minUa,
    maxUa,
    chargeUc,
    durationS,
  };
}
