# Power Profiler App

Browser-based client for the Nordic Semiconductor
[Power Profiler Kit II (PPK2)](https://www.nordicsemi.com/Software-and-tools/Development-Tools/Power-Profiler-Kit-2)
built on the **Web Serial API**. No backend, no drivers — just a web page.

## Features (v1)

- 🔌 Connect / disconnect via the browser device picker (Nordic VID `0x1915`, PID `0xC00A`)
- ⚡ Source-meter mode with programmable V<sub>DD</sub> (800–5000 mV) and DUT power switch
- 🔬 Ampere-meter mode (external supply passthrough)
- 📈 Live current chart powered by [uPlot](https://leeoniya.github.io/uPlot/)
- 📊 Live stats: average / min / max / charge (µC & mAh) / duration
- 🎚 Spike-filter toggle (matches official app behavior)
- 💾 Export CSV and the official `.ppk2` archive (loadable in nRF Connect Power Profiler)
- ⌨️ Space to start/stop sampling
- 🌒 Dark UI

Deferred to a later release: digital-channel logic view, trigger-based capture, `.ppk2` import,
IndexedDB session persistence, PWA install.

## Requirements

- A Chromium-based browser (**Chrome, Edge, Opera**) served over **HTTPS** or **localhost**.
  Firefox and Safari do not implement the Web Serial API.
- A PPK2 running firmware **≥ 1.2.4**.
- Node.js 20+ and npm (only for local development / building the static bundle).

## Getting started

### Option A — Dev container (recommended)

Open the folder in VS Code and pick **Dev Containers: Reopen in Container**.
Node.js 22 and all dependencies are installed automatically; port `5173` is
forwarded. See [`.devcontainer/README.md`](./.devcontainer/README.md) for the
Web Serial + USB caveat (short version: open the forwarded URL in a Chromium
browser on the **host** machine — the container only serves the JS bundle).

### Option B — Local install

```sh
npm install
npm run dev          # http://localhost:5173
```

To ship a static build:

```sh
npm run build
npm run preview      # serves ./dist
```

The `dist/` folder is a fully static site. Any static host works — the app deliberately does
not require `SharedArrayBuffer`, so no `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`
headers are needed.

## Architecture

```
┌──────────────── Main thread ─────────────────┐   ┌──── Web Worker ────┐
│  React UI  +  Zustand store  +  Recorder     │   │  SerialPort owner  │
│  ▲                                            │   │  Read loop         │
│  │ SampleBatch (Transferable typed arrays)   │◄──┤  Sample parser     │
│  │                                            │   │  Modifier math     │
│  └── Ppk2Client facade ──────postMessage─────►│   │                    │
└──────────────────────────────────────────────┘   └────────────────────┘
```

- `src/ppk2/protocol.ts` — command opcodes and builders
- `src/ppk2/modifiers.ts` — parses the ASCII calibration blob from the device
- `src/ppk2/sampleParser.ts` — decodes the 4-byte sample words into µA + digital bits
- `src/ppk2/worker.ts` — owns the `SerialPort`, drives the read loop
- `src/ppk2/client.ts` — main-thread facade over `postMessage`
- `src/ppk2/recorder.ts` — chunked in-memory storage + rolling stats
- `src/ppk2/export.ts` — CSV writer + `.ppk2` (ZIP) writer

## Tech stack

- **TypeScript** (strict) · **React 18** · **Vite** · **Zustand** · **uPlot** · **JSZip**
- Native **Web Serial API** and **Web Worker** — no polyfills, no native bridges

## References

- [`nordicsemi/pc-nrfconnect-ppk`](https://github.com/nordicsemi/pc-nrfconnect-ppk) — official Nordic app (TypeScript)
- [`IRNAS/ppk2-api-python`](https://github.com/IRNAS/ppk2-api-python) — unofficial Python API used to cross-reference the opcode table

## License

MIT.
