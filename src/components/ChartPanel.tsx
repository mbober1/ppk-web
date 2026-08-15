import { useEffect, useState } from "react";

import { useUiStore } from "../store";

/**
 * Chart display settings — currently just the Y-axis scale.
 *
 * The min/max fields are locally-buffered so the user can freely edit
 * them without every keystroke re-applying to the plot. Values commit on
 * blur or Enter, and are clamped so max > min.
 */
export function ChartPanel(): JSX.Element {
  const yAxis = useUiStore((s) => s.yAxis);
  const setAuto = useUiStore((s) => s.setYAxisAuto);
  const setRange = useUiStore((s) => s.setYAxisRange);

  const [minStr, setMinStr] = useState(String(yAxis.minMa));
  const [maxStr, setMaxStr] = useState(String(yAxis.maxMa));

  // Keep local edit buffers in sync when the store changes externally
  // (e.g. auto toggled back on and then off again).
  useEffect(() => {
    setMinStr(String(yAxis.minMa));
    setMaxStr(String(yAxis.maxMa));
  }, [yAxis.minMa, yAxis.maxMa]);

  const commit = () => {
    const min = Number(minStr);
    const max = Number(maxStr);
    if (!isFinite(min) || !isFinite(max)) {
      setMinStr(String(yAxis.minMa));
      setMaxStr(String(yAxis.maxMa));
      return;
    }
    // Ensure a non-degenerate range with max > min. If the user typed
    // max ≤ min, nudge max just above min to keep uPlot happy.
    const safeMax = max > min ? max : min + 0.001;
    setRange(min, safeMax);
  };

  return (
    <div className="panel">
      <h2>Chart</h2>
      <div className="field">
        <label htmlFor="y-auto">Y-axis auto</label>
        <input
          id="y-auto"
          type="checkbox"
          checked={yAxis.auto}
          onChange={(e) => setAuto(e.target.checked)}
        />
      </div>
      <div className="field">
        <label htmlFor="y-min">Min (mA)</label>
        <input
          id="y-min"
          type="number"
          step="0.1"
          value={minStr}
          disabled={yAxis.auto}
          onChange={(e) => setMinStr(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="y-max">Max (mA)</label>
        <input
          id="y-max"
          type="number"
          step="0.1"
          value={maxStr}
          disabled={yAxis.auto}
          onChange={(e) => setMaxStr(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 4 }}>
        Turn Auto off to lock the y-axis to a fixed range.
      </div>
    </div>
  );
}
