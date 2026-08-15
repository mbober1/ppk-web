/**
 * Export recorded samples to CSV or the official `.ppk2` archive format.
 *
 * The `.ppk2` format is a ZIP file with:
 *   - `session.raw`   packed samples: 4 B little-endian float (μA) + 2 B digital
 *   - `minimap.raw`   downsampled min/max preview (we generate a simple one)
 *   - `metadata.json` timing + version info consumed by the official app
 *
 * See https://github.com/nordicsemi/pc-nrfconnect-ppk#file-format for details.
 */

import JSZip from "jszip";

import { DEFAULT_SAMPLE_RATE_HZ } from "./protocol";

export function exportCsv(
  current: Float32Array,
  sampleRateHz: number = DEFAULT_SAMPLE_RATE_HZ,
): Blob {
  // Small helper: build a chunked string to avoid a single 200 MB concat.
  const parts: string[] = ["timestamp_us,current_ua\n"];
  const chunkRows = 10_000;
  let row = 0;
  while (row < current.length) {
    const end = Math.min(row + chunkRows, current.length);
    let s = "";
    for (let i = row; i < end; i++) {
      const tsUs = Math.round((i * 1_000_000) / sampleRateHz);
      s += `${tsUs},${current[i].toFixed(3)}\n`;
    }
    parts.push(s);
    row = end;
  }
  return new Blob(parts, { type: "text/csv;charset=utf-8" });
}

/**
 * Convert the 8-bit digital packing (D0 in bit 0) to the 16-bit format the
 * official app expects: two bits per channel, LSB is D0.
 */
function convertBits8To16(digital8: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) {
    const bit = (digital8 >> i) & 1;
    // Both bits of the pair carry the same value.
    out |= (bit ? 0b11 : 0) << (i * 2);
  }
  return out;
}

export async function exportPpk2(
  current: Float32Array,
  digital: Uint8Array,
  vddMv: number,
  sampleRateHz: number = DEFAULT_SAMPLE_RATE_HZ,
): Promise<Blob> {
  if (current.length !== digital.length) {
    throw new Error("current and digital sample count mismatch");
  }
  const n = current.length;

  // session.raw: 6 bytes per sample = 4 (float32 μA) + 2 (uint16 digital).
  const session = new ArrayBuffer(n * 6);
  const view = new DataView(session);
  for (let i = 0; i < n; i++) {
    view.setFloat32(i * 6, current[i], true);
    view.setUint16(i * 6 + 4, convertBits8To16(digital[i]), true);
  }

  // minimap.raw: simple min/max buckets (~2000 buckets total).
  const bucketCount = Math.min(2000, n);
  const bucketSize = Math.max(1, Math.floor(n / bucketCount));
  const minimap = new ArrayBuffer(bucketCount * 8); // 2 floats per bucket
  const mmView = new DataView(minimap);
  for (let b = 0; b < bucketCount; b++) {
    const start = b * bucketSize;
    const end = Math.min(start + bucketSize, n);
    let mn = current[start];
    let mx = mn;
    for (let i = start + 1; i < end; i++) {
      const v = current[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    mmView.setFloat32(b * 8, mn, true);
    mmView.setFloat32(b * 8 + 4, mx, true);
  }

  const metadata = {
    metadata: {
      samplesPerSecond: sampleRateHz,
      startSystemTime: Date.now(),
      recordingDuration: (n * 1000) / sampleRateHz,
      vdd: vddMv,
    },
    formatVersion: 2,
    producer: "ppk-web",
  };

  const zip = new JSZip();
  zip.file("session.raw", session);
  zip.file("minimap.raw", minimap);
  zip.file("metadata.json", JSON.stringify(metadata, null, 2));
  return await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
