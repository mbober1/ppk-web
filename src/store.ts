/**
 * Zustand store — the single source of truth for the UI.
 *
 * The recorder lives outside the store (heavy typed arrays), and the store
 * only holds a shallow copy of the latest Stats snapshot. This keeps React
 * re-renders cheap while the recorder still owns megabytes of samples.
 */

import { create } from "zustand";

import { loadJson, saveJson } from "./persist";
import { ppk2 } from "./ppk2/client";
import { downloadBlob, exportCsv, exportPpk2 } from "./ppk2/export";
import {
  DEFAULT_SAMPLE_RATE_HZ,
  SAMPLE_RATE_PRESETS,
  VDD_MAX_MV,
  VDD_MIN_MV,
  type PowerMode,
} from "./ppk2/protocol";
import { Recorder, emptyStats, type Stats } from "./ppk2/recorder";
import {
  clearAllRaw,
  deleteManyRaw,
  deleteRaw,
  getRaw,
  listRawIds,
  putRaw,
  type RawRecord,
} from "./rawStore";

export const recorder = new Recorder();

/** Persisted, human-configurable settings (device + chart). */
interface Settings {
  mode: PowerMode;
  voltageMv: number;
  spikeFilter: boolean;
  sampleRateHz: number;
  yAxis: { auto: boolean; minMa: number; maxMa: number };
}

/** A completed measurement, retained across page refreshes. */
export interface RecentMeasurement {
  id: string;
  startedAt: number;
  stoppedAt: number;
  stats: Stats;
  sampleRateHz: number;
  voltageMv: number;
  mode: PowerMode;
  /** True if raw samples are stored in IndexedDB under this id. */
  hasRaw: boolean;
}

const SETTINGS_KEY = "ppk-web:settings:v1";
const RECENTS_KEY = "ppk-web:recents:v1";
const RECENTS_CAP = 5;

const DEFAULT_SETTINGS: Settings = {
  mode: "source",
  voltageMv: 3300,
  spikeFilter: true,
  sampleRateHz: DEFAULT_SAMPLE_RATE_HZ,
  yAxis: { auto: true, minMa: 0, maxMa: 10 },
};

function validateSettings(raw: unknown): Settings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Settings> & { yAxis?: Partial<Settings["yAxis"]> };
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (r.mode === "source" || r.mode === "ampere") out.mode = r.mode;
  if (typeof r.voltageMv === "number" && Number.isFinite(r.voltageMv)) {
    out.voltageMv = Math.min(VDD_MAX_MV, Math.max(VDD_MIN_MV, r.voltageMv));
  }
  if (typeof r.spikeFilter === "boolean") out.spikeFilter = r.spikeFilter;
  if (
    typeof r.sampleRateHz === "number" &&
    SAMPLE_RATE_PRESETS.some((p) => p.hz === r.sampleRateHz)
  ) {
    out.sampleRateHz = r.sampleRateHz;
  }
  if (r.yAxis && typeof r.yAxis === "object") {
    const y = r.yAxis;
    const minMa =
      typeof y.minMa === "number" && Number.isFinite(y.minMa)
        ? y.minMa
        : DEFAULT_SETTINGS.yAxis.minMa;
    let maxMa =
      typeof y.maxMa === "number" && Number.isFinite(y.maxMa)
        ? y.maxMa
        : DEFAULT_SETTINGS.yAxis.maxMa;
    if (maxMa <= minMa) maxMa = minMa + 0.001;
    out.yAxis = {
      auto: typeof y.auto === "boolean" ? y.auto : DEFAULT_SETTINGS.yAxis.auto,
      minMa,
      maxMa,
    };
  }
  return out;
}

function validateStats(raw: unknown): Stats | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Stats>;
  const keys: (keyof Stats)[] = [
    "samples",
    "avgUa",
    "minUa",
    "maxUa",
    "chargeUc",
    "durationS",
  ];
  for (const k of keys) {
    if (typeof r[k] !== "number" || !Number.isFinite(r[k] as number)) {
      return null;
    }
  }
  return {
    samples: r.samples as number,
    avgUa: r.avgUa as number,
    minUa: r.minUa as number,
    maxUa: r.maxUa as number,
    chargeUc: r.chargeUc as number,
    durationS: r.durationS as number,
  };
}

function validateRecents(raw: unknown): RecentMeasurement[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RecentMeasurement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Partial<RecentMeasurement>;
    if (typeof r.id !== "string") continue;
    if (typeof r.startedAt !== "number" || typeof r.stoppedAt !== "number")
      continue;
    if (typeof r.sampleRateHz !== "number") continue;
    if (typeof r.voltageMv !== "number") continue;
    if (r.mode !== "source" && r.mode !== "ampere") continue;
    const stats = validateStats(r.stats);
    if (!stats) continue;
    out.push({
      id: r.id,
      startedAt: r.startedAt,
      stoppedAt: r.stoppedAt,
      stats,
      sampleRateHz: r.sampleRateHz,
      voltageMv: r.voltageMv,
      mode: r.mode,
      hasRaw: typeof r.hasRaw === "boolean" ? r.hasRaw : false,
    });
    if (out.length >= RECENTS_CAP) break;
  }
  return out;
}

/** Per-run raw-sample size cap (~50 MB budget). */
const MAX_RAW_BYTES = 50 * 1024 * 1024;
/** Bytes per sample in raw storage: 4 (Float32 current) + 1 (Uint8 digital). */
const BYTES_PER_SAMPLE = 5;

const initialSettings =
  loadJson<Settings>(SETTINGS_KEY, validateSettings) ?? DEFAULT_SETTINGS;
const initialRecents =
  loadJson<RecentMeasurement[]>(RECENTS_KEY, validateRecents) ?? [];

// Apply the persisted sample rate to the recorder immediately so that
// `maxDurationS` is correct on first render (before the device connects).
recorder.setSampleRate(initialSettings.sampleRateHz);

function recentFilename(r: RecentMeasurement, ext: string): string {
  const d = new Date(r.startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `ppk-web_${ts}.${ext}`;
}

/** Wall-clock timestamp of the current sampling run, or null if idle. */
let runStartedAt: number | null = null;

function makeSnapshot(now: number): {
  meta: RecentMeasurement;
  raw: RawRecord | null;
} | null {
  if (runStartedAt === null) return null;
  const stats = recorder.getStats();
  if (stats.samples === 0) return null;
  const s = useUiStore.getState();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${runStartedAt}-${Math.random().toString(36).slice(2, 8)}`;
  // Only take raw snapshots that fit our per-run budget. Larger runs
  // still get their summary stats in the recent list; raw simply isn't
  // available for re-export / waveform review.
  const estBytes = stats.samples * BYTES_PER_SAMPLE;
  let raw: RawRecord | null = null;
  if (estBytes <= MAX_RAW_BYTES) {
    try {
      raw = {
        current: recorder.snapshotCurrent(),
        digital: recorder.snapshotDigital(),
        sampleRateHz: s.sampleRateHz,
      };
    } catch {
      raw = null;
    }
  }
  return {
    meta: {
      id,
      startedAt: runStartedAt,
      stoppedAt: now,
      stats: { ...stats },
      sampleRateHz: s.sampleRateHz,
      voltageMv: s.voltageMv,
      mode: s.mode,
      hasRaw: raw !== null,
    },
    raw,
  };
}

/**
 * Push a completed snapshot onto the recents list, applying the FIFO cap.
 * Any recents dropped by the cap have their raw entries removed from IDB.
 * If `raw` is present, write it to IDB in the background — on quota errors,
 * silently mark the recent as raw-less.
 */
function commitSnapshot(snap: {
  meta: RecentMeasurement;
  raw: RawRecord | null;
}): void {
  let dropped: RecentMeasurement[] = [];
  useUiStore.setState((s) => {
    const combined = [snap.meta, ...s.recents];
    dropped = combined.slice(RECENTS_CAP);
    return { recents: combined.slice(0, RECENTS_CAP) };
  });
  if (dropped.length > 0) {
    void deleteManyRaw(dropped.filter((r) => r.hasRaw).map((r) => r.id));
  }
  if (snap.raw) {
    void putRaw(snap.meta.id, snap.raw).then((ok) => {
      if (!ok) {
        // IDB write failed (quota / disk). Downgrade the metadata so the
        // UI hides the export/preview affordances.
        useUiStore.setState((s) => ({
          recents: s.recents.map((r) =>
            r.id === snap.meta.id ? { ...r, hasRaw: false } : r,
          ),
        }));
      }
    });
  }
}

interface UiState {
  connected: boolean;
  sampling: boolean;
  error: string | null;
  // Controls
  mode: PowerMode;
  voltageMv: number;
  dutOn: boolean;
  spikeFilter: boolean;
  sampleRateHz: number;
  /** Maximum retainable recording length at the current rate (seconds). */
  maxDurationS: number;
  /**
   * Chart Y-axis settings. Values are in mA (matching the axis label units)
   * even though the underlying sample data is in µA — the chart divides at
   * render time. Purely UI state; no device I/O.
   */
  yAxis: { auto: boolean; minMa: number; maxMa: number };
  // Live stats (mirrored from Recorder ~5× / s)
  stats: Stats;
  /**
   * Monotonically increasing counter bumped whenever a new run starts.
   * LiveChart subscribes to this to clear its ring buffer.
   */
  resetSignal: number;
  /** Recent completed measurements, most-recent first, capped at 5. */
  recents: RecentMeasurement[];
  /** If non-null, StatsPanel shows this saved snapshot instead of live stats. */
  selectedRecentId: string | null;

  /**
   * The main chart's currently-visible X range (seconds). Null when there
   * is no data yet. Updated by LiveChart on every x-scale change; read by
   * ChartMinimap to position the viewport rectangle.
   */
  viewport: { min: number; max: number } | null;
  /**
   * Full extent of the current dataset (seconds). In live mode this is the
   * filled ring-buffer span; in snapshot mode it is the recording duration.
   * Null when no data is available. The minimap locks its x-scale to this
   * range so it always shows the complete horizon.
   */
  dataExtent: { min: number; max: number } | null;
  /**
   * When true, the minimap dragged the viewport away from the live right
   * edge. LiveChart reads this to stop auto-pinning the right edge and
   * ChartMinimap shows a "Return to live" button.
   */
  liveDetached: boolean;

  /**
   * Shift-drag time-range selection on the main chart (seconds), snapshot
   * mode only. Null when nothing is selected. Independent of `viewport` —
   * the selection stays anchored to its data range across zoom/pan.
   */
  selection: { min: number; max: number } | null;
  /** Stats computed over `selection`. Null exactly when `selection` is null. */
  selectionStats: Stats | null;

  setViewport: (min: number, max: number) => void;
  setDataExtent: (min: number, max: number) => void;
  setLiveDetached: (v: boolean) => void;
  setSelection: (min: number, max: number, stats: Stats) => void;
  clearSelection: () => void;

  setError: (m: string | null) => void;
  setMode: (m: PowerMode) => Promise<void>;
  setVoltageMv: (mv: number) => Promise<void>;
  setDut: (on: boolean) => Promise<void>;
  setSpikeFilter: (on: boolean) => Promise<void>;
  setSampleRateHz: (hz: number) => Promise<void>;
  setYAxisAuto: (auto: boolean) => void;
  setYAxisRange: (minMa: number, maxMa: number) => void;
  connect: (port?: SerialPort) => Promise<void>;
  disconnect: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refreshStats: () => void;
  selectRecent: (id: string | null) => void;
  deleteRecent: (id: string) => void;
  clearRecents: () => void;
  loadRecentRaw: (id: string) => Promise<RawRecord | null>;
  exportRecentCsv: (id: string) => Promise<boolean>;
  exportRecentPpk2: (id: string) => Promise<boolean>;
}

export const useUiStore = create<UiState>((set, get) => ({
  connected: false,
  sampling: false,
  error: null,
  mode: initialSettings.mode,
  voltageMv: initialSettings.voltageMv,
  dutOn: false,
  spikeFilter: initialSettings.spikeFilter,
  sampleRateHz: initialSettings.sampleRateHz,
  maxDurationS: recorder.maxDurationS,
  yAxis: initialSettings.yAxis,
  stats: emptyStats(),
  resetSignal: 0,
  recents: initialRecents,
  selectedRecentId: null,
  viewport: null,
  dataExtent: null,
  liveDetached: false,
  selection: null,
  selectionStats: null,

  setViewport: (min, max) => set({ viewport: { min, max } }),
  setDataExtent: (min, max) => set({ dataExtent: { min, max } }),
  setLiveDetached: (v) => set({ liveDetached: v }),
  setSelection: (min, max, stats) =>
    set({ selection: { min, max }, selectionStats: stats }),
  clearSelection: () => set({ selection: null, selectionStats: null }),

  setError: (error) => set({ error }),

  setMode: async (mode) => {
    await ppk2.setMode(mode);
    set({ mode });
  },
  setVoltageMv: async (mv) => {
    await ppk2.setVoltage(mv);
    set({ voltageMv: mv });
  },
  setDut: async (on) => {
    await ppk2.setDut(on);
    set({ dutOn: on });
  },
  setSpikeFilter: async (on) => {
    await ppk2.setSpikeFilter(on);
    set({ spikeFilter: on });
  },
  setSampleRateHz: async (hz) => {
    if (get().sampling) {
      throw new Error("Stop sampling before changing sample rate");
    }
    await ppk2.setSampleRate(hz);
    recorder.setSampleRate(hz);
    set({
      sampleRateHz: hz,
      maxDurationS: recorder.maxDurationS,
      stats: { ...recorder.getStats() },
    });
  },
  connect: async (port) => {
    try {
      await ppk2.connect(port);
      // Apply current UI settings to the freshly connected device.
      const s = get();
      await ppk2.setMode(s.mode);
      await ppk2.setVoltage(s.voltageMv);
      await ppk2.setSpikeFilter(s.spikeFilter);
      await ppk2.setSampleRate(s.sampleRateHz);
      recorder.setSampleRate(s.sampleRateHz);
      set({ maxDurationS: recorder.maxDurationS });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
  disconnect: async () => {
    // If sampling is still active when the device is yanked, snapshot the
    // run first so we don't lose it. Normal Stop → Disconnect flow has
    // already committed via stop().
    if (get().sampling) {
      const snap = makeSnapshot(Date.now());
      if (snap) commitSnapshot(snap);
    }
    runStartedAt = null;
    await ppk2.disconnect();
  },
  start: async () => {
    // Fresh run: wipe the recorder and reset the chart.
    recorder.reset();
    set((s) => ({
      stats: emptyStats(),
      resetSignal: s.resetSignal + 1,
      selectedRecentId: null,
      viewport: null,
      dataExtent: null,
      liveDetached: false,
      selection: null,
      selectionStats: null,
    }));
    runStartedAt = Date.now();
    await ppk2.start();
  },
  stop: async () => {
    await ppk2.stop();
    get().refreshStats();
    // Persist the just-finished run into recents (with raw samples if
    // small enough to fit our per-run budget).
    const snap = makeSnapshot(Date.now());
    if (snap) {
      commitSnapshot(snap);
      // Automatically switch to view mode on the run that just finished.
      set({ selectedRecentId: snap.meta.id });
    }
    runStartedAt = null;
  },
  selectRecent: (id) => {
    const cur = get();
    if (id === null && cur.selectedRecentId !== null && !cur.sampling) {
      // Returning to live mode ("New measurement") from a saved-run view
      // while nothing is currently recording: the ring buffer still holds
      // the previous run's samples. Clear it so the chart starts blank
      // instead of showing a stale trace until Start is pressed.
      recorder.reset();
      set((s) => ({
        selectedRecentId: null,
        stats: emptyStats(),
        resetSignal: s.resetSignal + 1,
        viewport: null,
        dataExtent: null,
        liveDetached: false,
        selection: null,
        selectionStats: null,
      }));
      return;
    }
    // Switching between saved measurements (or live → saved): any
    // selection belonged to the previous data array and must not leak.
    set({ selectedRecentId: id, selection: null, selectionStats: null });
  },
  deleteRecent: (id) => {
    const entry = get().recents.find((r) => r.id === id);
    if (entry?.hasRaw) void deleteRaw(id);
    set((s) => ({
      recents: s.recents.filter((r) => r.id !== id),
      selectedRecentId: s.selectedRecentId === id ? null : s.selectedRecentId,
      selection: s.selectedRecentId === id ? null : s.selection,
      selectionStats: s.selectedRecentId === id ? null : s.selectionStats,
    }));
  },
  clearRecents: () => {
    void clearAllRaw();
    set({
      recents: [],
      selectedRecentId: null,
      selection: null,
      selectionStats: null,
    });
  },
  loadRecentRaw: async (id) => {
    const entry = get().recents.find((r) => r.id === id);
    if (!entry?.hasRaw) return null;
    return getRaw(id);
  },
  exportRecentCsv: async (id) => {
    const entry = get().recents.find((r) => r.id === id);
    if (!entry) return false;
    const raw = await getRaw(id);
    if (!raw) return false;
    const blob = exportCsv(raw.current, raw.sampleRateHz);
    downloadBlob(blob, recentFilename(entry, "csv"));
    return true;
  },
  exportRecentPpk2: async (id) => {
    const entry = get().recents.find((r) => r.id === id);
    if (!entry) return false;
    const raw = await getRaw(id);
    if (!raw) return false;
    const blob = await exportPpk2(
      raw.current,
      raw.digital,
      entry.voltageMv,
      raw.sampleRateHz,
    );
    downloadBlob(blob, recentFilename(entry, "ppk2"));
    return true;
  },
  refreshStats: () => {
    // Copy so React sees a new object reference.
    set({ stats: { ...recorder.getStats() } });
  },
  setYAxisAuto: (auto) => {
    set((s) => ({ yAxis: { ...s.yAxis, auto } }));
  },
  setYAxisRange: (minMa, maxMa) => {
    set((s) => ({ yAxis: { ...s.yAxis, minMa, maxMa } }));
  },
}));

// Wire the client's event streams into the store exactly once.
ppk2.onStatus(({ connected, sampling }) => {
  useUiStore.setState({ connected, sampling });
});

ppk2.onError((message) => {
  useUiStore.setState({ error: message });
});

// Sample stream → recorder only. The live chart subscribes to ppk2.onSamples
// directly (see LiveChart.tsx) so it can update uPlot on rAF without going
// through React state — that avoided a full re-render per 40 ms batch.
ppk2.onSamples((batch) => {
  recorder.append(batch);
});

// Stats are refreshed on a fixed interval (~5 Hz) while sampling. This
// decouples the stats panel re-render rate from the sample batch rate.
let statsTimer: ReturnType<typeof setInterval> | null = null;
useUiStore.subscribe((state, prev) => {
  if (state.sampling === prev.sampling) return;
  if (state.sampling) {
    if (statsTimer !== null) clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      useUiStore.getState().refreshStats();
    }, 200);
  } else if (statsTimer !== null) {
    clearInterval(statsTimer);
    statsTimer = null;
    // Final refresh after stopping so panel shows the final numbers.
    useUiStore.getState().refreshStats();
  }
});

// -------- Persistence subscriptions --------
//
// We compare shallowly and only write when a persisted field changes so the
// 5 Hz stats refresh doesn't spam localStorage.

let lastSettingsJson = JSON.stringify(pickSettings(useUiStore.getState()));
let lastRecentsRef = useUiStore.getState().recents;

useUiStore.subscribe((state) => {
  if (state.recents !== lastRecentsRef) {
    lastRecentsRef = state.recents;
    saveJson(RECENTS_KEY, state.recents);
  }
  const settingsJson = JSON.stringify(pickSettings(state));
  if (settingsJson !== lastSettingsJson) {
    lastSettingsJson = settingsJson;
    saveJson(SETTINGS_KEY, JSON.parse(settingsJson) as Settings);
  }
});

function pickSettings(s: UiState): Settings {
  return {
    mode: s.mode,
    voltageMv: s.voltageMv,
    spikeFilter: s.spikeFilter,
    sampleRateHz: s.sampleRateHz,
    yAxis: s.yAxis,
  };
}

// Boot-time reconciliation between recents metadata and IDB:
//  1. Delete IDB rows whose metadata is gone (orphans).
//  2. Downgrade `hasRaw` to false for recents whose IDB row is missing
//     (e.g. an earlier session where the DB was broken). This prevents
//     the UI from advertising raw-only affordances that would fail.
void (async () => {
  const stored = new Set(await listRawIds());
  const validIds = new Set(
    initialRecents.filter((r) => r.hasRaw).map((r) => r.id),
  );
  const orphans = [...stored].filter((id) => !validIds.has(id));
  if (orphans.length > 0) await deleteManyRaw(orphans);
  useUiStore.setState((s) => {
    let changed = false;
    const next = s.recents.map((r) => {
      if (r.hasRaw && !stored.has(r.id)) {
        changed = true;
        return { ...r, hasRaw: false };
      }
      return r;
    });
    return changed ? { recents: next } : {};
  });
})();
