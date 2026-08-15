import { useEffect, useRef } from "react";
import uPlot, { type AlignedData, type Options } from "uplot";

import { ppk2 } from "../ppk2/client";
import { useUiStore } from "../store";

/**
 * Live current chart.
 *
 * Design notes:
 *  - Subscribes to ppk2.onSamples directly (bypassing the Zustand store) so
 *    that new sample batches never trigger a React re-render. React
 *    re-rendering the whole app at 25 fps (one per 4096-sample batch) was
 *    a big fraction of the previous CPU cost.
 *  - Maintains a rolling window that always represents ~LIVE_WINDOW_SECONDS
 *    of wall-clock time. When the sample rate changes, the window is
 *    resized (samples-per-window = rate × seconds) and the x-axis is
 *    recomputed. Capped at MAX_WINDOW_SAMPLES so 100 kHz stays performant.
 *  - Redraws via uPlot.setData at rAF cadence, so we render at most once
 *    per frame regardless of how many batches arrive.
 */

const LIVE_WINDOW_SECONDS = 2;
// Absolute cap to protect the renderer at high sample rates. 200k points
// still renders at 60 fps in uPlot on a modern laptop.
const MAX_WINDOW_SAMPLES = 200_000;
const MIN_WINDOW_SAMPLES = 256;

function windowSamplesFor(rateHz: number): number {
  const ideal = Math.round(rateHz * LIVE_WINDOW_SECONDS);
  return Math.max(MIN_WINDOW_SAMPLES, Math.min(MAX_WINDOW_SAMPLES, ideal));
}

export function LiveChart(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Subscribe to the y-axis scale config. This only changes when the user
  // edits it in the ChartPanel, so re-running the effect below is cheap
  // and never happens on the per-batch hot path.
  const yAxis = useUiStore((s) => s.yAxis);
  // Bumped by store.start() each time a new run begins. We use it to wipe
  // the rolling ring buffer so the chart always starts at t=0 with no
  // stale trace from the previous run.
  const resetSignal = useUiStore((s) => s.resetSignal);
  // When non-null, we render the corresponding saved run's raw samples
  // instead of the live ring buffer, and pause live-sample intake.
  const selectedRecentId = useUiStore((s) => s.selectedRecentId);
  const loadRecentRaw = useUiStore((s) => s.loadRecentRaw);
  const selectedRef = useRef<string | null>(null);

  // Ring buffer state, held in refs so React never re-renders on updates.
  // Sized for the initial rate; may be reallocated when the rate changes.
  const initialRate = ppk2.getSampleRate();
  const initialWin = windowSamplesFor(initialRate);
  const yRef = useRef<Float32Array>(new Float32Array(initialWin));
  const xRef = useRef<Float64Array>(new Float64Array(initialWin));
  const rateRef = useRef<number>(initialRate);
  const filledRef = useRef<number>(0);
  const dirtyRef = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null);

  // (Re)build the x-axis to reflect the current sample rate. Called at
  // mount and whenever the incoming batch reports a new rate.
  const rebuildAxis = (rateHz: number) => {
    const win = windowSamplesFor(rateHz);
    rateRef.current = rateHz;
    if (yRef.current.length !== win) {
      yRef.current = new Float32Array(win);
      xRef.current = new Float64Array(win);
      filledRef.current = 0;
    }
    const x = xRef.current;
    for (let i = 0; i < x.length; i++) x[i] = i / rateHz;
  };

  // Create the plot once.
  useEffect(() => {
    if (!containerRef.current) return;

    rebuildAxis(rateRef.current);

    const opts: Options = {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      pxAlign: false,
      scales: {
        y: { auto: true },
        x: { time: false },
      },
      axes: [
        {
          stroke: "#8a92a2",
          grid: { stroke: "#2d323d", width: 1 },
          values: (_u, splits) => splits.map((s) => `${s.toFixed(2)} s`),
        },
        {
          stroke: "#8a92a2",
          grid: { stroke: "#2d323d", width: 1 },
          size: 90,
          values: (_u, splits) =>
            splits.map((v) => {
              if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)} mA`;
              return `${v.toFixed(1)} µA`;
            }),
        },
      ],
      series: [
        {},
        {
          label: "Current",
          stroke: "#4f8cff",
          width: 1,
          points: { show: false },
        },
      ],
      cursor: { drag: { x: true, y: false } },
    };

    plotRef.current = new uPlot(
      opts,
      [xRef.current, yRef.current] as AlignedData,
      containerRef.current,
    );

    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !plotRef.current) return;
      plotRef.current.setSize({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, []);

  // Subscribe to samples once. The callback appends into the ring buffer
  // and marks it dirty; the actual uPlot redraw is coalesced to rAF.
  useEffect(() => {
    const scheduleDraw = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (!plotRef.current || !dirtyRef.current) return;
        dirtyRef.current = false;
        // Use setData with a view sized to the filled portion so the
        // chart isn't padded with zeros on startup.
        const n = filledRef.current;
        if (n === yRef.current.length) {
          plotRef.current.setData([xRef.current, yRef.current] as AlignedData);
        } else {
          plotRef.current.setData([
            xRef.current.subarray(0, n),
            yRef.current.subarray(0, n),
          ] as AlignedData);
        }
      });
    };

    const unsubscribe = ppk2.onSamples((batch) => {
      // Paused while showing a saved run — still accumulate into the ring
      // so live data isn't lost, but skip the redraw.
      const showingSaved = selectedRef.current !== null;
      // Rate change → rebuild axis + resize ring buffer, then continue.
      if (batch.sampleRateHz !== rateRef.current) {
        rebuildAxis(batch.sampleRateHz);
        if (plotRef.current) {
          plotRef.current.setData([
            xRef.current.subarray(0, 0),
            yRef.current.subarray(0, 0),
          ] as AlignedData);
        }
      }

      const src = batch.current;
      const y = yRef.current;
      const cap = y.length;
      const incoming = src.length;

      if (incoming >= cap) {
        // Batch alone exceeds the window — just take its tail.
        y.set(src.subarray(incoming - cap));
        filledRef.current = cap;
      } else if (filledRef.current + incoming <= cap) {
        // Fits without shifting; append at the current fill point.
        y.set(src, filledRef.current);
        filledRef.current += incoming;
      } else {
        // Shift left by `incoming`, then write new samples at the end.
        y.copyWithin(0, incoming);
        y.set(src, cap - incoming);
        filledRef.current = cap;
      }

      dirtyRef.current = true;
      if (!showingSaved) scheduleDraw();
    });

    return () => {
      unsubscribe();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  // Apply the y-axis scale settings. Underlying samples are in µA, so mA
  // bounds from the store are multiplied by 1000.
  //
  // Important: uPlot normalizes `scale.auto` to a *function* at init
  // (`sc.auto = fnOrSelf(sc.auto)`), and calls it as `sc.auto(self, …)`
  // on every subsequent `setData`. Overwriting the live scale's `auto`
  // with a plain boolean therefore throws mid-render and freezes the
  // chart. We must always assign a function.
  //
  // We also skip this effect entirely on first mount with the default
  // (auto=true) — otherwise we'd force an early `setData` before the
  // sample subscription has filled the ring buffer.
  const wentManualRef = useRef(false);
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const yScale = plot.scales.y as {
      auto?: unknown;
      min?: number;
      max?: number;
    };
    if (!yAxis.auto) {
      wentManualRef.current = true;
      // Prevent subsequent setData() calls from re-autoranging Y.
      yScale.auto = (() => false) as typeof yScale.auto;
      plot.setScale("y", {
        min: yAxis.minMa * 1000,
        max: yAxis.maxMa * 1000,
      });
    } else if (wentManualRef.current) {
      // Restore auto-ranging: put the auto fn back and nudge a redraw
      // so the axis snaps to the current data immediately.
      yScale.auto = (() => true) as typeof yScale.auto;
      const n = filledRef.current;
      if (n > 0) {
        plot.setData([
          xRef.current.subarray(0, n),
          yRef.current.subarray(0, n),
        ] as AlignedData);
      }
    }
  }, [yAxis]);

  // Wipe the ring buffer whenever a new run starts. The initial mount
  // fires with resetSignal=0 which is harmless (buffer is already empty).
  useEffect(() => {
    yRef.current.fill(0);
    filledRef.current = 0;
    dirtyRef.current = false;
    if (plotRef.current) {
      plotRef.current.setData([
        xRef.current.subarray(0, 0),
        yRef.current.subarray(0, 0),
      ] as AlignedData);
    }
  }, [resetSignal]);

  // Render the selected saved run — or, when cleared, restore the live
  // ring-buffer view. We keep the live subscription running so no samples
  // are missed while a saved run is being reviewed.
  useEffect(() => {
    selectedRef.current = selectedRecentId;
    const plot = plotRef.current;
    if (!plot) return;

    if (selectedRecentId === null) {
      // Restore whatever the live ring currently holds. Rebuild x-axis
      // in case the live rate differs from the saved run's rate we just
      // showed.
      rebuildAxis(rateRef.current);
      const n = filledRef.current;
      plot.setData([
        xRef.current.subarray(0, n),
        yRef.current.subarray(0, n),
      ] as AlignedData);
      return;
    }

    let cancelled = false;
    void loadRecentRaw(selectedRecentId).then((raw) => {
      if (cancelled || !plotRef.current) return;
      if (!raw || raw.current.length === 0) {
        // No raw data available — leave the chart empty and show nothing.
        plotRef.current.setData([
          new Float64Array(0),
          new Float32Array(0),
        ] as unknown as AlignedData);
        return;
      }
      // Downsample if the saved run is larger than what uPlot can render
      // quickly. Simple stride sampling keeps the shape recognisable and
      // is O(n).
      const rate = raw.sampleRateHz;
      const src = raw.current;
      const n = src.length;
      const stride = Math.max(1, Math.ceil(n / MAX_WINDOW_SAMPLES));
      const outLen = Math.ceil(n / stride);
      const xs = new Float64Array(outLen);
      const ys = new Float32Array(outLen);
      for (let i = 0, j = 0; i < n; i += stride, j++) {
        xs[j] = i / rate;
        ys[j] = src[i];
      }
      plotRef.current.setData([xs, ys] as AlignedData);
    });

    return () => {
      cancelled = true;
    };
  }, [selectedRecentId, loadRecentRaw]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", minHeight: 320 }}
    />
  );
}
