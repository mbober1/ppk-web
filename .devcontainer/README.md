# Dev container

Node.js 22 LTS on Debian Bookworm, matching the Vite/React toolchain declared
in `package.json`. First open of the workspace triggers `npm install`; Vite
runs on port `5173` and is auto-forwarded.

## Usage

1. In VS Code: **Dev Containers: Reopen in Container**.
2. Wait for the post-create `npm install` to finish (once).
3. Open a terminal and run `npm run dev`. The forwarded port opens
   automatically in the Simple Browser or your host browser.

## Web Serial + USB caveat

The PPK2 speaks over USB, and the browser reaches USB devices via the
**Web Serial API**. There is **no reliable way to pass a raw USB device from
the host into a Docker container across all platforms** (in particular, macOS
and Windows both hide USB from the container VM). Two workflows work well:

### A. Host browser + container dev server (recommended)

Run Vite inside the container as usual, but open the forwarded URL in a
**Chromium browser on your host machine** (Chrome/Edge/Opera). The browser
holds the serial port; the container merely serves the JS bundle. This works
identically on Linux, macOS, and Windows.

### B. Host-only build

If you'd rather skip the container entirely, install Node.js 22 on the host
and run `npm install && npm run dev`. The devcontainer is optional.

## Troubleshooting

- **`npm run dev` succeeds but the browser can't reach it** — make sure the
  port is forwarded (it is by default; check the *Ports* panel).
- **`navigator.serial` is undefined in the browser** — you're on Firefox or
  Safari. Switch to a Chromium-based browser. HTTPS or `localhost` is required.
- **Device picker is empty on Linux** — your user needs read/write on
  `/dev/ttyACM*`. Add yourself to the `dialout` group:
  `sudo usermod -aG dialout $USER && newgrp dialout`.
