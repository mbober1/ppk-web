import { useEffect, useRef } from "react";
import uPlot, { type AlignedData, type Options } from "uplot";

import { ppk2 } from "../ppk2/client";
import { decimateMinMaxRange } from "../ppk2/decimate";
import { useUiStore } from "../store";

// Small epsilon used to avoid feedback loops when syncing viewport between
// LiveChart and ChartMinimap: we only publish a new viewport to the store
// when it has actually changed by more than this threshold (seconds).
const VIEWPORT_EPSILON = 1e-6;

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

const LIVE_WINDOW_SECONDS = 10;
// Absolute cap to protect the renderer at high sample rates. 200k points
// still renders at 60 fps in uPlot on a modern laptop.
const MAX_WINDOW_SAMPLES = 5 * 200_000;
const MIN_WINDOW_SAMPLES = 256;
// Adaptive decimation: only decimate when visible samples exceed this
// multiple of the chart's pixel width. Below the threshold we show raw
// samples for full fidelity. Above it we target 2×pixelWidth output points
// (one min/max pair per pixel). Capped at MAX_RENDER_PTS for safety.
const DECIMATE_THRESHOLD = 2;
const MAX_RENDER_PTS = 4_000;

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

  // Store actions — kept in refs so effects that capture them once don't
  // need to be re-run when the store object identity changes.
  const setViewport = useUiStore((s) => s.setViewport);
  const setDataExtent = useUiStore((s) => s.setDataExtent);
  const setLiveDetached = useUiStore((s) => s.setLiveDetached);
  // The minimap writes liveDetached to tell us to stop auto-pinning.
  const liveDetached = useUiStore((s) => s.liveDetached);
  const liveDetachedRef = useRef(false);

  // The minimap instructs the main chart to jump to a specific range by
  // writing to viewport in the store. We consume that via a separate
  // subscription so it doesn't trigger React re-renders via state.
  // We keep a ref to the last viewport we *published* so we can ignore
  // echoes (i.e. our own writes) in that subscription.
  const lastPublishedViewport = useRef<{ min: number; max: number } | null>(
    null,
  );

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
  // Visible live window duration (seconds). Scroll mutates this; the rAF
  // draw loop reads it to pin the right edge to the latest sample.
  const liveWindowRef = useRef<number>(LIVE_WINDOW_SECONDS);
  // Full duration of the currently displayed snapshot (seconds). Used to
  // clamp the snapshot zoom so you can't scroll past the data extents.
  const snapshotDurationRef = useRef<number>(0);
  // Raw snapshot data held so renderSnapshot() can re-decimate on zoom/resize.
  const snapshotRawRef = useRef<Float32Array | null>(null);
  const snapshotRateRef = useRef<number>(1);
  // Cached store setters (stable refs, never change between renders).
  const setViewportRef = useRef(setViewport);
  const setDataExtentRef = useRef(setDataExtent);
  const setLiveDetachedRef = useRef(setLiveDetached);
  setViewportRef.current = setViewport;
  setDataExtentRef.current = setDataExtent;
  setLiveDetachedRef.current = setLiveDetached;

  /** Publish viewport to the store, guarding against feedback loops. */
  const publishViewport = (min: number, max: number) => {
    const lp = lastPublishedViewport.current;
    if (
      lp &&
      Math.abs(lp.min - min) < VIEWPORT_EPSILON &&
      Math.abs(lp.max - max) < VIEWPORT_EPSILON
    )
      return;
    lastPublishedViewport.current = { min, max };
    setViewportRef.current(min, max);
  };

  // Returns the plot canvas width in CSS pixels (never zero).
  const pixelWidth = (): number =>
    Math.max(
      1,
      plotRef.current?.width ?? containerRef.current?.clientWidth ?? 800,
    );

  // Decimate `src` (at `rate` Hz) over the visible x-range [xMin, xMax] and
  // push into uPlot via setData(..., false). Used in snapshot mode after
  // every zoom / pan / resize.
  //
  // IMPORTANT: xMin/xMax are passed explicitly rather than read from
  // `plot.scales.x` because callers may need to render the *new* range
  // *before* invoking setScale (see applySnapshotScale). If we relied on
  // plot.scales.x here, we'd re-decimate for the OLD range and uPlot's
  // subsequent setScale pass would compute i0/i1 against stale data,
  // producing corner gaps on the first frame after zoom/pan.
  const renderSnapshot = (
    src: Float32Array,
    rate: number,
    xMin: number,
    xMax: number,
  ) => {
    const plot = plotRef.current;
    if (!plot) return;
    const startIdx = Math.max(0, Math.floor(xMin * rate));
    const endIdx = Math.min(src.length, Math.ceil(xMax * rate) + 1);
    const visibleSamples = endIdx - startIdx;
    const pw = pixelWidth();
    const targetPts = Math.min(MAX_RENDER_PTS, 2 * pw);
    const { xs, ys } =
      visibleSamples > DECIMATE_THRESHOLD * pw
        ? decimateMinMaxRange(src, startIdx, endIdx, rate, targetPts)
        : decimateMinMaxRange(src, startIdx, endIdx, rate, visibleSamples);
    plot.setData([xs, ys] as AlignedData, false);
  };

  // Change the snapshot x-scale, re-decimating the data first so that
  // uPlot's setScales pass computes i0/i1 against the fresh data. If we
  // called setScale first, uPlot would run setScales against the stale
  // (previous zoom level) data — computing i0/i1 that don't line up with
  // the freshly decimated array we then push in the setScale hook — which
  // manifested as corner gaps that vanish only after a subsequent pan.
  const applySnapshotScale = (xMin: number, xMax: number) => {
    const plot = plotRef.current;
    const src = snapshotRawRef.current;
    if (!plot || src === null) return;
    renderSnapshot(src, snapshotRateRef.current, xMin, xMax);
    plot.setScale("x", { min: xMin, max: xMax });
  };

  // Build the data arrays to feed uPlot for the live ring buffer.
  // Decimates when visible samples exceed DECIMATE_THRESHOLD × pixelWidth.
  //
  // xMin/xMax may be omitted; when so we compute them from
  // liveWindowRef (attached) or plot.scales.x (detached). Explicit values
  // let callers render for a new range *before* invoking setScale — see
  // the comment on renderSnapshot for why that ordering matters.
  const renderLive = (n: number, xMinArg?: number, xMaxArg?: number) => {
    const plot = plotRef.current;
    if (!plot || n === 0) return;
    const rate = rateRef.current;
    const latestT = (n - 1) / rate;
    let xMin: number;
    let xMax: number;
    if (xMinArg != null && xMaxArg != null) {
      xMin = xMinArg;
      xMax = xMaxArg;
    } else if (liveDetachedRef.current) {
      xMax = plot.scales.x.max ?? latestT;
      xMin = plot.scales.x.min ?? xMax - liveWindowRef.current;
    } else {
      xMax = latestT;
      xMin = xMax - liveWindowRef.current;
    }
    const startIdx = Math.max(0, Math.floor(xMin * rate));
    const endIdx = Math.min(n, Math.ceil(xMax * rate) + 1);
    const visibleSamples = endIdx - startIdx;
    const pw = pixelWidth();
    const src = yRef.current;
    if (visibleSamples > DECIMATE_THRESHOLD * pw) {
      const targetPts = Math.min(MAX_RENDER_PTS, 2 * pw);
      const { xs, ys } = decimateMinMaxRange(
        src,
        startIdx,
        endIdx,
        rate,
        targetPts,
      );
      plot.setData([xs, ys] as AlignedData, false);
    } else {
      // Raw path — no allocation needed when we pass raw subarrays.
      // Re-build x for the visible slice.
      const len = endIdx - startIdx;
      const xs = new Float64Array(len);
      for (let i = 0; i < len; i++) xs[i] = (startIdx + i) / rate;
      plot.setData([xs, src.subarray(startIdx, endIdx)] as AlignedData, false);
    }
  };

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
      cursor: { drag: { x: false, y: false } },
      hooks: {
        setScale: [
          (u, scaleKey) => {
            if (scaleKey !== "x") return;
            const { min, max } = u.scales.x;
            if (min == null || max == null) return;
            publishViewport(min, max);
            // NOTE: we intentionally do NOT re-decimate here. Callers that
            // change the x-scale in snapshot mode go through
            // applySnapshotScale, which pushes fresh data via setData()
            // *before* invoking setScale. Doing the decimation inside this
            // hook (i.e. after uPlot's setScales pass has already run)
            // would leave the internal i0/i1 indices computed from stale
            // data, producing corner gaps on the very first frame after
            // a zoom/pan that only clear on the next scale change.
          },
        ],
      },
    };

    plotRef.current = new uPlot(
      opts,
      [xRef.current, yRef.current] as AlignedData,
      containerRef.current,
    );

    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !plotRef.current) return;
      const plot = plotRef.current;
      plot.setSize({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
      // Re-decimate to the new pixel width.
      const raw = snapshotRawRef.current;
      if (raw !== null) {
        const xMin = plot.scales.x.min ?? 0;
        const xMax = plot.scales.x.max ?? snapshotDurationRef.current;
        renderSnapshot(raw, snapshotRateRef.current, xMin, xMax);
      } else {
        const n = filledRef.current;
        if (n > 0) renderLive(n);
      }
      // Force uPlot to recompute i0/i1 from the fresh data. Otherwise
      // getOuterIdxs() during draw would clamp against stale indices
      // computed from the previous decimation, producing corner gaps.
      // Same min/max means the setScale hook won't fire (no feedback).
      plot.redraw(true, false);
    });
    ro.observe(containerRef.current);

    // --- Scroll-to-zoom ---
    // Live mode   : scroll adjusts the visible window size; the rAF draw
    //               loop always pins the right edge to the latest sample.
    // Snapshot mode: scroll zooms in/out anchored to the cursor position.
    const ZOOM_FACTOR = 1.15;
    const onWheel = (e: WheelEvent) => {
      const plot = plotRef.current;
      if (!plot) return;
      e.preventDefault();

      const factor = e.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
      const minSpan = 10 / rateRef.current;

      if (selectedRef.current === null) {
        // Live mode — adjust window duration, clamped to [minSpan, LIVE_WINDOW_SECONDS].
        liveWindowRef.current = Math.min(
          LIVE_WINDOW_SECONDS,
          Math.max(minSpan, liveWindowRef.current * factor),
        );
        // The rAF loop will pick up the new window on its next tick.
      } else {
        // Snapshot mode — zoom around the cursor X position.
        const xScale = plot.scales.x;
        const curMin = xScale.min ?? 0;
        const curMax = xScale.max ?? snapshotDurationRef.current;
        // posToVal expects the pixel offset relative to the plot's left edge.
        const anchor = plot.posToVal(
          e.offsetX - plot.bbox.left / devicePixelRatio,
          "x",
        );
        let newMin = anchor - (anchor - curMin) * factor;
        let newMax = anchor + (curMax - anchor) * factor;
        // Clamp: keep within [0, snapshotDuration] and enforce minSpan.
        const duration = snapshotDurationRef.current;
        newMin = Math.max(0, newMin);
        newMax = Math.min(duration, newMax);
        if (newMax - newMin < minSpan) {
          // Restore the old range if we'd go below the minimum span.
          newMin = curMin;
          newMax = curMax;
        }
        applySnapshotScale(newMin, newMax);
      }
    };
    containerRef.current.addEventListener("wheel", onWheel, { passive: false });

    // --- Left-button drag-to-pan ---
    // Replaces uPlot's built-in drag-zoom rectangle (disabled above).
    // In live mode, detaches the right-edge pin just like the minimap drag.
    // In snapshot mode, clamps within [0, snapshotDuration].
    let panStartX = 0;
    let panStartMin = 0;
    let panStartMax = 0;
    let panStartWindow = 0; // live only
    let panPending = false;

    const onPanDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const plot = plotRef.current;
      if (!plot) return;
      // Guard: no data to pan yet.
      if (selectedRef.current === null && filledRef.current === 0) return;

      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      panStartX = e.clientX;
      panStartMin = plot.scales.x.min ?? 0;
      panStartMax = plot.scales.x.max ?? liveWindowRef.current;
      panStartWindow = panStartMax - panStartMin;
      panPending = true;

      if (containerRef.current) containerRef.current.style.cursor = "grabbing";
    };

    const onPanMove = (e: PointerEvent) => {
      if (!panPending) return;
      const plot = plotRef.current;
      if (!plot) return;

      const dx = e.clientX - panStartX;
      const span = panStartMax - panStartMin;
      // Convert pixel delta → time delta using the chart's current pixel width.
      const dtTime = (dx / pixelWidth()) * span;

      let newMin = panStartMin - dtTime;
      let newMax = panStartMax - dtTime;

      if (selectedRef.current === null) {
        // Live mode — detach from the right edge so the rAF loop stops pinning.
        if (!liveDetachedRef.current) {
          liveDetachedRef.current = true;
          setLiveDetachedRef.current(true);
        }
        const latestT =
          filledRef.current > 0 ? (filledRef.current - 1) / rateRef.current : 0;
        // Clamp inside [0, latestT], preserving span.
        if (newMin < 0) {
          newMin = 0;
          newMax = span;
        }
        if (newMax > latestT) {
          newMax = latestT;
          newMin = latestT - span;
        }
        // Keep liveWindowRef in sync so wheel-zoom stays consistent.
        liveWindowRef.current = newMax - newMin;
        // Render fresh decimation for the new visible range BEFORE
        // setScale so uPlot's setScales computes i0/i1 against the
        // updated data. (Same rationale as applySnapshotScale.)
        renderLive(filledRef.current, newMin, newMax);
        plot.setScale("x", { min: newMin, max: newMax });
      } else {
        // Snapshot mode — clamp inside [0, snapshotDuration].
        const dur = snapshotDurationRef.current;
        if (newMin < 0) {
          newMin = 0;
          newMax = span;
        }
        if (newMax > dur) {
          newMax = dur;
          newMin = dur - span;
        }
        applySnapshotScale(newMin, newMax);
      }
    };

    const onPanUp = (e: PointerEvent) => {
      if (!panPending) return;
      panPending = false;
      (e.currentTarget as HTMLElement)?.releasePointerCapture(e.pointerId);
      if (containerRef.current) containerRef.current.style.cursor = "grab";
    };

    const el = containerRef.current;
    el.addEventListener("pointerdown", onPanDown);
    el.addEventListener("pointermove", onPanMove);
    el.addEventListener("pointerup", onPanUp);
    el.addEventListener("pointercancel", onPanUp as EventListener);

    return () => {
      containerRef.current?.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPanDown);
      el.removeEventListener("pointermove", onPanMove);
      el.removeEventListener("pointerup", onPanUp);
      el.removeEventListener("pointercancel", onPanUp as EventListener);
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
        const n = filledRef.current;
        // Pin the right edge to the latest sample and respect the current
        // live window size set by scroll. Only applied in live mode.
        if (selectedRef.current === null && n > 0) {
          const xMax = (n - 1) / rateRef.current;
          // Publish the full data extent so the minimap can lock its x-domain.
          setDataExtentRef.current(0, xMax);
          if (!liveDetachedRef.current) {
            const win = liveWindowRef.current;
            const xMin = xMax - win;
            // Data first, then scale — see comment on applySnapshotScale.
            renderLive(n, xMin, xMax);
            plotRef.current.setScale("x", { min: xMin, max: xMax });
          } else {
            renderLive(n);
          }
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
      const raw = snapshotRawRef.current;
      if (raw !== null) {
        const xMin = plot.scales.x.min ?? 0;
        const xMax = plot.scales.x.max ?? snapshotDurationRef.current;
        renderSnapshot(raw, snapshotRateRef.current, xMin, xMax);
      } else {
        const n = filledRef.current;
        if (n > 0) renderLive(n);
      }
      // Force uPlot to recompute i0/i1 against the fresh data.
      plot.redraw(true, false);
    }
  }, [yAxis]);

  // Wipe the ring buffer whenever a new run starts. The initial mount
  // fires with resetSignal=0 which is harmless (buffer is already empty).
  useEffect(() => {
    yRef.current.fill(0);
    filledRef.current = 0;
    dirtyRef.current = false;
    liveWindowRef.current = LIVE_WINDOW_SECONDS;
    liveDetachedRef.current = false;
    lastPublishedViewport.current = null;
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
      snapshotRawRef.current = null;
      rebuildAxis(rateRef.current);
      const n = filledRef.current;
      if (n > 0) renderLive(n);
      else
        plot.setData([
          new Float64Array(0),
          new Float32Array(0),
        ] as unknown as AlignedData);
      return;
    }

    let cancelled = false;
    void loadRecentRaw(selectedRecentId).then((raw) => {
      if (cancelled || !plotRef.current) return;
      if (!raw || raw.current.length === 0) {
        snapshotRawRef.current = null;
        plotRef.current.setData([
          new Float64Array(0),
          new Float32Array(0),
        ] as unknown as AlignedData);
        return;
      }
      const rate = raw.sampleRateHz;
      const src = raw.current;
      const duration = (src.length - 1) / rate;
      snapshotRawRef.current = src;
      snapshotRateRef.current = rate;
      snapshotDurationRef.current = duration;
      // Publish full extent so the minimap can lock its x-domain.
      setDataExtentRef.current(0, duration);
      // Set x-scale to full view. Data-first-then-scale via
      // applySnapshotScale ensures uPlot's setScales pass computes
      // i0/i1 against the freshly decimated data (no corner gaps).
      applySnapshotScale(0, duration);
    });

    return () => {
      cancelled = true;
      // Clear the raw ref so renderSnapshot doesn't fire for a stale run.
      snapshotRawRef.current = null;
    };
  }, [selectedRecentId, loadRecentRaw]);

  // When returning to live mode, reset the visible window.
  useEffect(() => {
    if (selectedRecentId === null) {
      liveWindowRef.current = LIVE_WINDOW_SECONDS;
    }
  }, [selectedRecentId]);

  // Keep liveDetachedRef in sync with the store value (written by minimap).
  useEffect(() => {
    liveDetachedRef.current = liveDetached;
  }, [liveDetached]);

  // Subscribe to the store's viewport field. When the minimap (or another
  // consumer) updates viewport, apply it to the main plot — unless it
  // matches what we just published ourselves (feedback-loop guard).
  useEffect(() => {
    const unsub = useUiStore.subscribe((state) => {
      const vp = state.viewport;
      if (!vp || !plotRef.current) return;
      const lp = lastPublishedViewport.current;
      if (
        lp &&
        Math.abs(lp.min - vp.min) < VIEWPORT_EPSILON &&
        Math.abs(lp.max - vp.max) < VIEWPORT_EPSILON
      )
        return;
      // External write — apply to the main chart without triggering another
      // publish (we set lastPublishedViewport first so the hook above is
      // a no-op for this change).
      lastPublishedViewport.current = { ...vp };
      if (snapshotRawRef.current !== null) {
        // Re-decimate for the new range before setScale so uPlot's
        // setScales pass computes i0/i1 from the fresh data.
        applySnapshotScale(vp.min, vp.max);
      } else {
        // Live mode — decimate current ring buffer for the new range.
        const n = filledRef.current;
        if (n > 0) renderLive(n, vp.min, vp.max);
        plotRef.current.setScale("x", { min: vp.min, max: vp.max });
      }
    });
    return unsub;
  }, []);

  // When the snapshot loads, publish its extent to the store.
  // The actual setData call already happens inside the selectedRecentId
  // effect below; we intercept here by observing snapshotDurationRef
  // after that effect runs. The cleanest way is to publish directly
  // inside the async .then() — see the selectedRecentId effect.

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", minHeight: 320, cursor: "grab" }}
    />
  );
}
