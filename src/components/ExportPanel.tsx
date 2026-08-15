import { useState } from "react";

import { downloadBlob, exportCsv, exportPpk2 } from "../ppk2/export";
import { recorder, useUiStore } from "../store";

export function ExportPanel(): JSX.Element {
  const stats = useUiStore((s) => s.stats);
  const voltage = useUiStore((s) => s.voltageMv);
  const rateHz = useUiStore((s) => s.sampleRateHz);
  const [busy, setBusy] = useState(false);
  const empty = stats.samples === 0;

  const onCsv = () => {
    const blob = exportCsv(recorder.snapshotCurrent(), rateHz);
    downloadBlob(blob, filename("csv"));
  };
  const onPpk2 = async () => {
    setBusy(true);
    try {
      const blob = await exportPpk2(
        recorder.snapshotCurrent(),
        recorder.snapshotDigital(),
        voltage,
        rateHz,
      );
      downloadBlob(blob, filename("ppk2"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Export</h2>
      <div className="row">
        <button disabled={empty || busy} onClick={onCsv} style={{ flex: 1 }}>
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
        {empty
          ? "No samples recorded yet."
          : `${stats.samples.toLocaleString()} samples (${stats.durationS.toFixed(1)} s)`}
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
