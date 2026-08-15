import { SAMPLE_RATE_PRESETS } from "../ppk2/protocol";
import { useUiStore } from "../store";

export function Controls(): JSX.Element {
  const connected = useUiStore((s) => s.connected);
  const sampling = useUiStore((s) => s.sampling);
  const spike = useUiStore((s) => s.spikeFilter);
  const setSpike = useUiStore((s) => s.setSpikeFilter);
  const rateHz = useUiStore((s) => s.sampleRateHz);
  const setRateHz = useUiStore((s) => s.setSampleRateHz);
  const maxDurationS = useUiStore((s) => s.maxDurationS);
  const start = useUiStore((s) => s.start);
  const stop = useUiStore((s) => s.stop);
  const setError = useUiStore((s) => s.setError);

  return (
    <div className="panel">
      <h2>Sampling</h2>
      <div className="row">
        <button
          className="primary"
          disabled={!connected || sampling}
          onClick={() => void start()}
          style={{ flex: 1 }}
        >
          ▶ Start
        </button>
        <button
          className="danger"
          disabled={!connected || !sampling}
          onClick={() => void stop()}
          style={{ flex: 1 }}
        >
          ■ Stop
        </button>
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="rate">Sample rate</label>
        <select
          id="rate"
          value={rateHz}
          disabled={sampling}
          onChange={(e) => {
            const hz = Number(e.target.value);
            setRateHz(hz).catch((err) =>
              setError(err instanceof Error ? err.message : String(err)),
            );
          }}
        >
          {SAMPLE_RATE_PRESETS.map((p) => (
            <option key={p.hz} value={p.hz}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 4 }}>
        Max recording ≈ {formatDuration(maxDurationS)} at {formatRate(rateHz)}
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="spike">Spike filter</label>
        <input
          id="spike"
          type="checkbox"
          checked={spike}
          disabled={!connected}
          onChange={(e) => void setSpike(e.target.checked)}
        />
      </div>
      <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 8 }}>
        Tip: press <kbd>Space</kbd> to start/stop. Hardware ADC is fixed at 100
        kSa/s; slower rates are software-averaged.
      </div>
    </div>
  );
}

function formatRate(hz: number): string {
  if (hz >= 1000) return `${hz / 1000} kHz`;
  return `${hz} Hz`;
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const totalMin = seconds / 60;
  if (totalMin < 60) {
    const m = Math.floor(totalMin);
    const s = Math.round(seconds - m * 60);
    return s > 0 ? `${m} min ${s} s` : `${m} min`;
  }
  const totalHr = totalMin / 60;
  if (totalHr < 48) {
    const h = Math.floor(totalHr);
    const m = Math.round(totalMin - h * 60);
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }
  return `${(totalHr / 24).toFixed(1)} days`;
}
