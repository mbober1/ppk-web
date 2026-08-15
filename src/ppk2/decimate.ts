/**
 * Min/max bucket decimation shared by LiveChart and ChartMinimap.
 *
 * Each bucket emits two output samples — the min and the max in chronological
 * order — so the output length is at most `2 × buckets`. This faithfully
 * preserves spike amplitude even at extreme zoom-out levels.
 */

/**
 * Decimate a contiguous sub-range of `src` (sample indices [startIdx, endIdx))
 * into at most `targetPts` output points using min/max bucketing.
 *
 * @param src       Full (possibly ring-buffered) Float32Array in µA.
 * @param startIdx  First sample index to include (inclusive).
 * @param endIdx    One-past-the-last sample index (exclusive).
 * @param rateHz    Sample rate used to compute x timestamps (seconds).
 * @param targetPts Approximate desired output length (the actual length is
 *                  `2 × ceil((endIdx-startIdx) / stride)`, which is ≤ `targetPts`).
 * @returns         Decimated { xs, ys } typed arrays ready for uPlot.setData.
 */
export function decimateMinMaxRange(
  src: Float32Array,
  startIdx: number,
  endIdx: number,
  rateHz: number,
  targetPts: number,
): { xs: Float64Array; ys: Float32Array } {
  const n = endIdx - startIdx;
  if (n <= 0) return { xs: new Float64Array(0), ys: new Float32Array(0) };
  if (n <= targetPts) {
    // Already small enough — return a view of the raw sub-range.
    const xs = new Float64Array(n);
    const ys = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = (startIdx + i) / rateHz;
      ys[i] = src[startIdx + i];
    }
    return { xs, ys };
  }

  const buckets = Math.max(1, Math.floor(targetPts / 2));
  const stride = Math.max(1, Math.floor(n / buckets));
  // +2 slots for explicit first/last endpoint pins that guarantee the line
  // spans the full [startIdx, endIdx-1] range (avoids "gap at corner"
  // artifacts caused by bucket min/max landing mid-bucket).
  const maxOut = Math.ceil(n / stride) * 2 + 2;
  const xs = new Float64Array(maxOut);
  const ys = new Float32Array(maxOut);
  let out = 0;

  // Pin the first sample of the range so the line starts at the left edge.
  xs[out] = startIdx / rateHz;
  ys[out++] = src[startIdx];

  for (let b = 0; b < n; b += stride) {
    const bEnd = Math.min(b + stride, n);
    let minV = src[startIdx + b];
    let maxV = src[startIdx + b];
    let minI = b;
    let maxI = b;
    for (let i = b + 1; i < bEnd; i++) {
      const v = src[startIdx + i];
      if (v < minV) {
        minV = v;
        minI = i;
      }
      if (v > maxV) {
        maxV = v;
        maxI = i;
      }
    }
    // Emit min and max in chronological order.
    if (minI <= maxI) {
      xs[out] = (startIdx + minI) / rateHz;
      ys[out++] = minV;
      xs[out] = (startIdx + maxI) / rateHz;
      ys[out++] = maxV;
    } else {
      xs[out] = (startIdx + maxI) / rateHz;
      ys[out++] = maxV;
      xs[out] = (startIdx + minI) / rateHz;
      ys[out++] = minV;
    }
  }

  // Pin the last sample of the range so the line reaches the right edge.
  // (Monotonicity holds: the last bucket's min/max index is < n, and this
  // pin is at n - 1, so xs stays non-decreasing.)
  const lastIdx = startIdx + n - 1;
  xs[out] = lastIdx / rateHz;
  ys[out++] = src[lastIdx];

  return { xs: xs.subarray(0, out), ys: ys.subarray(0, out) };
}

/**
 * Convenience wrapper: decimate an entire array (startIdx=0, endIdx=src.length).
 */
export function decimateMinMax(
  src: Float32Array,
  rateHz: number,
  targetPts: number,
): { xs: Float64Array; ys: Float32Array } {
  return decimateMinMaxRange(src, 0, src.length, rateHz, targetPts);
}
