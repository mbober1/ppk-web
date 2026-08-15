import { useUiStore } from "../store";

function fmtCurrent(ua: number): string {
  if (!Number.isFinite(ua)) return "—";
  if (Math.abs(ua) >= 1_000_000) return `${(ua / 1_000_000).toFixed(3)} A`;
  if (Math.abs(ua) >= 1_000) return `${(ua / 1_000).toFixed(3)} mA`;
  return `${ua.toFixed(2)} µA`;
}

function fmtCharge(uc: number): string {
  // µC → mAh: 1 mAh = 3600 mC = 3_600_000 µC
  const mc = uc / 1000;
  const mah = uc / 3_600_000;
  return `${mc.toFixed(2)} mC (${mah.toFixed(4)} mAh)`;
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s.toFixed(1)} s`;
  const min = Math.floor(s / 60);
  const rem = s - min * 60;
  return `${min}m ${rem.toFixed(1)}s`;
}

export function StatsPanel(): JSX.Element {
  const liveStats = useUiStore((s) => s.stats);
  const selected = useUiStore((s) =>
    s.selectedRecentId
      ? (s.recents.find((r) => r.id === s.selectedRecentId) ?? null)
      : null,
  );
  const selectRecent = useUiStore((s) => s.selectRecent);
  const selection = useUiStore((s) => s.selection);
  const selectionStats = useUiStore((s) => s.selectionStats);
  const clearSelection = useUiStore((s) => s.clearSelection);

  const viewingSaved = selected !== null;
  const hasSelection = selection !== null && selectionStats !== null;

  // While a shift-drag selection is active, it takes over the stats row
  // entirely (red-accented) — the underlying whole-recording/live stats
  // are still there underneath, just temporarily hidden.
  const stats = hasSelection
    ? selectionStats!
    : selected
      ? selected.stats
      : liveStats;

  return (
    <div>
      {hasSelection ? (
        <div className="stats-banner selection">
          <span>
            Selection: {fmtDuration(selection!.min)} →{" "}
            {fmtDuration(selection!.max)}
          </span>
          <button className="link" onClick={() => clearSelection()}>
            Clear
          </button>
        </div>
      ) : (
        viewingSaved && (
          <div className="stats-banner">
            <span>Viewing saved measurement</span>
            <button className="link" onClick={() => selectRecent(null)}>
              Back to live
            </button>
          </div>
        )
      )}
      <div className={hasSelection ? "stats selection" : "stats"}>
        <div className="stat">
          <div className="label">Average</div>
          <div className="value">{fmtCurrent(stats.avgUa)}</div>
        </div>
        <div className="stat">
          <div className="label">Min</div>
          <div className="value">{fmtCurrent(stats.minUa)}</div>
        </div>
        <div className="stat">
          <div className="label">Max</div>
          <div className="value">{fmtCurrent(stats.maxUa)}</div>
        </div>
        <div className="stat">
          <div className="label">Charge</div>
          <div className="value">{fmtCharge(stats.chargeUc)}</div>
        </div>
        <div className="stat">
          <div className="label">Duration</div>
          <div className="value">{fmtDuration(stats.durationS)}</div>
        </div>
      </div>
    </div>
  );
}
