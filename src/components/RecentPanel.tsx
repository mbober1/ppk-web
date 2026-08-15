import { useUiStore } from "../store";

function fmtCurrent(ua: number): string {
  if (!Number.isFinite(ua)) return "—";
  if (Math.abs(ua) >= 1_000_000) return `${(ua / 1_000_000).toFixed(2)} A`;
  if (Math.abs(ua) >= 1_000) return `${(ua / 1_000).toFixed(2)} mA`;
  return `${ua.toFixed(1)} µA`;
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function RecentPanel(): JSX.Element {
  const recents = useUiStore((s) => s.recents);
  const selectedId = useUiStore((s) => s.selectedRecentId);
  const selectRecent = useUiStore((s) => s.selectRecent);
  const deleteRecent = useUiStore((s) => s.deleteRecent);
  const clearRecents = useUiStore((s) => s.clearRecents);

  return (
    <div className="panel">
      <h2>Measurements</h2>
      <ul className="recent-list">
        <li
          key="__live__"
          className={`recent-item${selectedId === null ? " selected" : ""}`}
          onClick={() => selectRecent(null)}
          title="Show the live measurement"
        >
          <div className="recent-item-main">
            <div className="recent-item-time">LIVE</div>
            <div className="recent-item-meta">Current measurement</div>
          </div>
        </li>
        {recents.map((r) => {
          const isSelected = r.id === selectedId;
          return (
            <li
              key={r.id}
              className={`recent-item${isSelected ? " selected" : ""}`}
              onClick={() => selectRecent(isSelected ? null : r.id)}
              title="Click to view stats for this run"
            >
              <div className="recent-item-main">
                <div className="recent-item-time">{fmtTime(r.startedAt)}</div>
                <div className="recent-item-meta">
                  {fmtDuration(r.stats.durationS)} · avg{" "}
                  {fmtCurrent(r.stats.avgUa)}
                </div>
              </div>
              <button
                className="recent-item-del"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteRecent(r.id);
                }}
                aria-label="Delete measurement"
                title="Delete"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      {recents.length === 0 ? (
        <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 8 }}>
          No saved measurements yet. Each Stop saves the run here (max 5).
        </div>
      ) : (
        <div className="row" style={{ marginTop: 8 }}>
          <button
            onClick={() => clearRecents()}
            disabled={recents.length === 0}
            style={{ flex: 1 }}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
