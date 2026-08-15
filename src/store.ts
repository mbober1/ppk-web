/**
 * Zustand store — the single source of truth for the UI.
 *
 * The recorder lives outside the store (heavy typed arrays), and the store
 * only holds a shallow copy of the latest Stats snapshot. This keeps React
 * re-renders cheap while the recorder still owns megabytes of samples.
 */

import { create } from "zustand";

import { ppk2 } from "./ppk2/client";
import { DEFAULT_SAMPLE_RATE_HZ, type PowerMode } from "./ppk2/protocol";
import { Recorder, emptyStats, type Stats } from "./ppk2/recorder";

export const recorder = new Recorder();

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
  // Live stats (mirrored from Recorder ~5× / s)
  stats: Stats;

  setError: (m: string | null) => void;
  setMode: (m: PowerMode) => Promise<void>;
  setVoltageMv: (mv: number) => Promise<void>;
  setDut: (on: boolean) => Promise<void>;
  setSpikeFilter: (on: boolean) => Promise<void>;
  setSampleRateHz: (hz: number) => Promise<void>;
  connect: (port?: SerialPort) => Promise<void>;
  disconnect: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refreshStats: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  connected: false,
  sampling: false,
  error: null,
  mode: "source",
  voltageMv: 3300,
  dutOn: false,
  spikeFilter: true,
  sampleRateHz: DEFAULT_SAMPLE_RATE_HZ,
  maxDurationS: recorder.maxDurationS,
  stats: emptyStats(),

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
    await ppk2.disconnect();
  },
  start: async () => {
    recorder.reset();
    set({ stats: emptyStats() });
    await ppk2.start();
  },
  stop: async () => {
    await ppk2.stop();
    get().refreshStats();
  },
  refreshStats: () => {
    // Copy so React sees a new object reference.
    set({ stats: { ...recorder.getStats() } });
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
