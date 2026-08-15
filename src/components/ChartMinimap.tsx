/**
 * ChartMinimap — compact full-range overview below the main chart.
 *
 * Design:
 *  - A second uPlot instance (no axes, no cursor, thin muted stroke) whose
 *    x-scale is always locked to the full data extent, giving a bird's-eye
 *    view of the entire current dataset.
 *  - An absolutely-positioned overlay div (`.minimap-viewport`) represents
 *    the main chart's currently-visible range and supports:
 *      • Body drag  → pan
 *      • Left / right handle drag  → resize (zoom)
 *      • Click on empty track  → centre viewport on click position
 *  - An independent decimated buffer (~2000 points, min/max bucketing) is
 *    maintained by subscribing to ppk2.onSamples in live mode, or by
 *    downsampling the loaded raw snapshot. This decouples the minimap from
 *    LiveChart's internal ring-buffer refs.
 *  - While `dataExtent` is null (no data available), a dashed empty-state
 *    placeholder is shown instead of the uPlot canvas.
 *  - In live mode, if the minimap drags the viewport away from the right
 *    edge a "Return to live" button appears; clicking it reattaches.
 */

import { useCallback, useEffect, useRef } from "react";
import uPlot, { type AlignedData, type Options } from "uplot";

import { ppk2 } from "../ppk2/client";
import { decimateMinMax } from "../ppk2/decimate";
import { useUiStore } from "../store";

// Maximum number of points kept in the minimap decimated buffer.
const MINIMAP_PTS = 2_000;
// Handle hit-area width in CSS pixels.
const HANDLE_PX = 8;

// ── Component ────────────────────────────────────────────────────────────────

export function ChartMinimap(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  // Live decimated buffer (maintained independently of LiveChart).
  const miniXRef = useRef<Float64Array>(new Float64Array(0));
  const miniYRef = useRef<Float32Array>(new Float32Array(0));
  const miniRateRef = useRef<number>(1);
  // Ring-buffer accumulator for live mode (raw, un-decimated).
  // We keep all received samples so we can re-decimate when the extent grows.
  // Capped at 10× MINIMAP_PTS samples to bound memory; at 100 kHz that is
  // only ~2 MB for a float32 array (20 k × 4 B).
  const liveAccRef = useRef<Float32Array>(new Float32Array(0));
  const liveAccFilledRef = useRef<number>(0);
  const LIVE_ACC_CAP = MINIMAP_PTS * 10;

  const dirtyRef = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null);

  // Store slices (read-only in this component).
  const viewport = useUiStore((s) => s.viewport);
  const dataExtent = useUiStore((s) => s.dataExtent);
  const liveDetached = useUiStore((s) => s.liveDetached);
  const selectedRecentId = useUiStore((s) => s.selectedRecentId);
  const loadRecentRaw = useUiStore((s) => s.loadRecentRaw);
  const setViewport = useUiStore((s) => s.setViewport);
  const setLiveDetached = useUiStore((s) => s.setLiveDetached);
  const resetSignal = useUiStore((s) => s.resetSignal);

  // Refs so pointer-event closures always read current values.
  const viewportRef = useRef(viewport);
  const dataExtentRef = useRef(dataExtent);
  const setViewportRef = useRef(setViewport);
  const setLiveDetachedRef = useRef(setLiveDetached);
  viewportRef.current = viewport;
  dataExtentRef.current = dataExtent;
  setViewportRef.current = setViewport;
  setLiveDetachedRef.current = setLiveDetached;

  // ── uPlot creation ──────────────────────────────────────────────────────

  // Re-run whenever dataExtent transitions from null → non-null so that
  // containerRef.current is actually mounted (showEmpty flips to false first).
  const hasData = dataExtent !== null;

  useEffect(() => {
    if (!hasData) return; // minimap-inner not yet mounted
    if (!containerRef.current) return;

    const opts: Options = {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      pxAlign: false,
      padding: [4, 0, 4, 0],
      scales: {
        x: { time: false },
        y: { auto: true },
      },
      axes: [{ show: false }, { show: false }],
      legend: { show: false },
      cursor: { show: false },
      series: [
        {},
        {
          label: "Current",
          stroke: "#8a92a2",
          width: 1,
          points: { show: false },
          fill: "rgba(79,140,255,0.06)",
        },
      ],
    };

    plotRef.current = new uPlot(
      opts,
      [miniXRef.current, miniYRef.current] as AlignedData,
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
  }, [hasData]);

  // ── rAF draw loop ───────────────────────────────────────────────────────

  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (!plotRef.current || !dirtyRef.current) return;
      dirtyRef.current = false;
      plotRef.current.setData(
        [miniXRef.current, miniYRef.current] as AlignedData,
        false, // don't reset scales — the range is managed externally
      );
      // Re-lock the x-scale to the full data extent.
      const ext = dataExtentRef.current;
      if (ext && plotRef.current) {
        plotRef.current.setScale("x", { min: ext.min, max: ext.max });
      }
    });
  }, []);

  // ── Live sample subscription (independent decimated ring) ───────────────

  useEffect(() => {
    const unsub = ppk2.onSamples((batch) => {
      if (selectedRecentId !== null) return; // snapshot mode — ignore live

      const rate = batch.sampleRateHz;
      if (rate !== miniRateRef.current) {
        // Rate changed: reset the accumulator.
        miniRateRef.current = rate;
        liveAccRef.current = new Float32Array(LIVE_ACC_CAP);
        liveAccFilledRef.current = 0;
      }

      // Append into the accumulator (simple rolling ring).
      const src = batch.current;
      const acc = liveAccRef.current;
      const cap = acc.length;
      const incoming = src.length;
      if (incoming >= cap) {
        acc.set(src.subarray(incoming - cap));
        liveAccFilledRef.current = cap;
      } else if (liveAccFilledRef.current + incoming <= cap) {
        acc.set(src, liveAccFilledRef.current);
        liveAccFilledRef.current += incoming;
      } else {
        acc.copyWithin(0, incoming);
        acc.set(src, cap - incoming);
        liveAccFilledRef.current = cap;
      }

      // Decimate the filled portion into the minimap buffer.
      const filled = liveAccFilledRef.current;
      const { xs, ys } = decimateMinMax(
        acc.subarray(0, filled),
        rate,
        MINIMAP_PTS,
      );
      miniXRef.current = xs;
      miniYRef.current = ys;
      dirtyRef.current = true;
      scheduleDraw();
    });

    return () => {
      unsub();
    };
  }, [selectedRecentId, scheduleDraw]);

  // ── Snapshot mode ───────────────────────────────────────────────────────

  useEffect(() => {
    if (selectedRecentId === null) return; // live mode handled above

    let cancelled = false;
    void loadRecentRaw(selectedRecentId).then((raw) => {
      if (cancelled) return;
      if (!raw || raw.current.length === 0) {
        miniXRef.current = new Float64Array(0);
        miniYRef.current = new Float32Array(0);
        dirtyRef.current = true;
        scheduleDraw();
        return;
      }
      const { xs, ys } = decimateMinMax(
        raw.current,
        raw.sampleRateHz,
        MINIMAP_PTS,
      );
      miniXRef.current = xs;
      miniYRef.current = ys;
      dirtyRef.current = true;
      scheduleDraw();
    });

    return () => {
      cancelled = true;
    };
  }, [selectedRecentId, loadRecentRaw, scheduleDraw]);

  // ── Lock minimap x-scale to dataExtent whenever it changes ─────────────

  useEffect(() => {
    if (!plotRef.current) return;
    if (!dataExtent) return;
    plotRef.current.setScale("x", { min: dataExtent.min, max: dataExtent.max });
  }, [dataExtent]);

  // ── Reset on new run ────────────────────────────────────────────────────

  useEffect(() => {
    liveAccRef.current = new Float32Array(LIVE_ACC_CAP);
    liveAccFilledRef.current = 0;
    miniXRef.current = new Float64Array(0);
    miniYRef.current = new Float32Array(0);
    dirtyRef.current = true;
    scheduleDraw();
  }, [resetSignal, scheduleDraw]);

  // ── Viewport rectangle geometry ─────────────────────────────────────────

  // Convert a viewport range to CSS left% + width% relative to the minimap
  // plot canvas (not the full container, which may include y-axis gutter).
  const getViewportStyle = () => {
    if (!viewport || !dataExtent) return null;
    const ext = dataExtent.max - dataExtent.min;
    if (ext <= 0) return null;
    const leftFrac = (viewport.min - dataExtent.min) / ext;
    const rightFrac = (viewport.max - dataExtent.min) / ext;
    return {
      left: `${Math.max(0, leftFrac * 100).toFixed(3)}%`,
      width: `${Math.max(0, (rightFrac - leftFrac) * 100).toFixed(3)}%`,
    };
  };

  // ── Pointer interactions ─────────────────────────────────────────────────

  // Convert a pixel offset from the container left edge to a time value.
  const pxToTime = (px: number): number => {
    const ext = dataExtentRef.current;
    if (!ext || !containerRef.current) return 0;
    const w = containerRef.current.clientWidth;
    return ext.min + (px / w) * (ext.max - ext.min);
  };

  const startDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    mode: "pan" | "left" | "right",
  ) => {
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startVp = viewportRef.current;
    const ext0 = dataExtentRef.current;
    if (!startVp || !ext0) return;

    const startMin = startVp.min;
    const startMax = startVp.max;
    const span = startMax - startMin;
    const extSpan = ext0.max - ext0.min;
    const containerW = containerRef.current?.clientWidth ?? 1;
    const minSpan = Math.max(0.01, extSpan / MINIMAP_PTS);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dtSeconds = (dx / containerW) * (ext0.max - ext0.min);
      const ext = dataExtentRef.current ?? ext0;

      let newMin = startMin;
      let newMax = startMax;

      if (mode === "pan") {
        newMin = startMin + dtSeconds;
        newMax = startMax + dtSeconds;
        // Clamp so the viewport stays inside the data extent.
        if (newMin < ext.min) {
          newMin = ext.min;
          newMax = ext.min + span;
        }
        if (newMax > ext.max) {
          newMax = ext.max;
          newMin = ext.max - span;
        }
      } else if (mode === "left") {
        newMin = Math.min(startMin + dtSeconds, startMax - minSpan);
        newMin = Math.max(ext.min, newMin);
      } else {
        newMax = Math.max(startMax + dtSeconds, startMin + minSpan);
        newMax = Math.min(ext.max, newMax);
      }

      // Signal that the user has manually panned/resized — detach live edge.
      if (selectedRecentId === null) {
        setLiveDetachedRef.current(true);
      }
      setViewportRef.current(newMin, newMax);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const ext = dataExtentRef.current;
    const vp = viewportRef.current;
    if (!ext || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const clickTime = pxToTime(e.clientX - rect.left);

    const span = vp ? vp.max - vp.min : (ext.max - ext.min) * 0.2;
    let newMin = clickTime - span / 2;
    let newMax = clickTime + span / 2;
    if (newMin < ext.min) {
      newMin = ext.min;
      newMax = ext.min + span;
    }
    if (newMax > ext.max) {
      newMax = ext.max;
      newMin = ext.max - span;
    }

    if (selectedRecentId === null) {
      setLiveDetachedRef.current(true);
    }
    setViewportRef.current(newMin, newMax);
  };

  const returnToLive = () => {
    setLiveDetachedRef.current(false);
  };

  // ── Render ──────────────────────────────────────────────────────────────

  const vpStyle = getViewportStyle();
  const showEmpty = !dataExtent;

  return (
    <div className="minimap-wrap">
      {showEmpty ? (
        <div className="minimap-empty">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            style={{ opacity: 0.5 }}
          >
            <rect
              x="1"
              y="5"
              width="14"
              height="6"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeDasharray="3 2"
            />
            <line
              x1="8"
              y1="1"
              x2="8"
              y2="15"
              stroke="currentColor"
              strokeWidth="1"
              strokeDasharray="2 2"
              opacity="0.5"
            />
          </svg>
          <span>Start sampling to see overview</span>
        </div>
      ) : (
        <div
          className="minimap-inner"
          ref={containerRef}
          onClick={onTrackClick}
        >
          {/* uPlot mounts here */}

          {vpStyle && (
            <div
              className="minimap-viewport"
              style={{ left: vpStyle.left, width: vpStyle.width }}
              onPointerDown={(e) => {
                // Determine which zone was hit (handle vs body).
                const rect = e.currentTarget.getBoundingClientRect();
                const relX = e.clientX - rect.left;
                if (relX < HANDLE_PX) {
                  startDrag(e, "left");
                } else if (relX > rect.width - HANDLE_PX) {
                  startDrag(e, "right");
                } else {
                  startDrag(e, "pan");
                }
              }}
              onClick={(e) => e.stopPropagation()} // prevent track-click
            >
              <div className="minimap-handle minimap-handle-left" />
              <div className="minimap-handle minimap-handle-right" />
            </div>
          )}

          {liveDetached && selectedRecentId === null && (
            <button
              className="minimap-live-btn"
              onClick={(e) => {
                e.stopPropagation();
                returnToLive();
              }}
            >
              ↩ Live
            </button>
          )}
        </div>
      )}
    </div>
  );
}
