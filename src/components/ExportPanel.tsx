import { useState } from "react";

import { downloadBlob, exportCsv, exportPpk2 } from "../ppk2/export";
import { recorder, useUiStore } from "../store";

export function ExportPanel(): JSX.Element {
  const stats = useUiStore((s) => s.stats);
  const voltage = useUiStore((s) => s.voltageMv);
  const rateHz = useUiStore((s) => s.sampleRateHz);
  const selectedRecentId = useUiStore((s) => s.selectedRecentId);
  const recents = useUiStore((s) => s.recents);
  const exportRecentCsv = useUiStore((s) => s.exportRecentCsv);
  const exportRecentPpk2 = useUiStore((s) => s.exportRecentPpk2);
  const [busy, setBusy] = useState(false);

  const selectedRecent =
    selectedRecentId !== null
      ? (recents.find((r) => r.id === selectedRecentId) ?? null)
      : null;

  // When a saved run is selected, "empty" means it has no raw data.
  const empty =
    selectedRecent !== null ? !selectedRecent.hasRaw : stats.samples === 0;

  const onCsv = async () => {
    if (selectedRecentId !== null) {
      setBusy(true);
      try {
        await exportRecentCsv(selectedRecentId);
      } finally {
        setBusy(false);
      }
    } else {
      const blob = exportCsv(recorder.snapshotCurrent(), rateHz);
      downloadBlob(blob, filename("csv"));
    }
  };

  const onPpk2 = async () => {
    setBusy(true);
    try {
      if (selectedRecentId !== null) {
        await exportRecentPpk2(selectedRecentId);
      } else {
        const blob = await exportPpk2(
          recorder.snapshotCurrent(),
          recorder.snapshotDigital(),
          voltage,
          rateHz,
        );
        downloadBlob(blob, filename("ppk2"));
      }
    } finally {
      setBusy(false);
    }
  };

  const hint = selectedRecent
    ? selectedRecent.hasRaw
      ? `Saved run · ${selectedRecent.stats.samples.toLocaleString()} samples (${selectedRecent.stats.durationS.toFixed(1)} s)`
      : "Raw samples not stored for this run — export unavailable."
    : stats.samples === 0
      ? "No samples recorded yet."
      : `${stats.samples.toLocaleString()} samples (${stats.durationS.toFixed(1)} s)`;

  return (
    <div className="panel">
      <h2>Export</h2>
      <div className="row">
        <button
          disabled={empty || busy}
          onClick={() => void onCsv()}
          style={{ flex: 1 }}
        >
          CSV
        </button>
        <button
          disabled={empty || busy}
          onClick={() => void onPpk2()}
          style={{ flex: 1 }}
        >
          .ppk2
        </button>
      </div>
      <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 8 }}>
        {hint}
      </div>
    </div>
  );
}

function filename(ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `ppk-web_${ts}.${ext}`;
}
