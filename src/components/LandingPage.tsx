import { useCallback, useEffect, useState } from "react";

import { Ppk2Client } from "../ppk2/client";
import { useUiStore } from "../store";

interface PortEntry {
  port: SerialPort;
  key: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
  label: string;
}

function hex4(n: number | undefined): string {
  return n === undefined
    ? "????"
    : n.toString(16).padStart(4, "0").toUpperCase();
}

function describePort(port: SerialPort, index: number): PortEntry {
  const info = port.getInfo();
  // usbSerialNumber is exposed on recent Chromium versions but not part of
  // the standard type. Treat it as optional.
  const sn = (info as { usbSerialNumber?: string }).usbSerialNumber;
  const idPart = `USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}`;
  const key = `${info.usbVendorId ?? "?"}:${info.usbProductId ?? "?"}:${sn ?? `#${index}`}`;
  return {
    port,
    key,
    vendorId: info.usbVendorId,
    productId: info.usbProductId,
    serialNumber: sn,
    label: sn ? `${idPart} · SN ${sn}` : idPart,
  };
}

export function LandingPage(): JSX.Element {
  const connect = useUiStore((s) => s.connect);
  const error = useUiStore((s) => s.error);
  const setError = useUiStore((s) => s.setError);

  const supported = Ppk2Client.isSupported();

  const [ports, setPorts] = useState<PortEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported) {
      setScanning(false);
      return;
    }
    setScanning(true);
    const found = await Ppk2Client.listPorts();
    const entries = found.map((p, i) => describePort(p, i));
    setPorts(entries);
    setSelectedKey((prev) => {
      if (prev && entries.some((e) => e.key === prev)) return prev;
      return entries[0]?.key ?? null;
    });
    setScanning(false);
  }, [supported]);

  useEffect(() => {
    void refresh();
    if (!supported) return;
    const onChange = () => void refresh();
    navigator.serial.addEventListener("connect", onChange);
    navigator.serial.addEventListener("disconnect", onChange);
    return () => {
      navigator.serial.removeEventListener("connect", onChange);
      navigator.serial.removeEventListener("disconnect", onChange);
    };
  }, [refresh, supported]);

  const doConnect = async (port: SerialPort) => {
    setError(null);
    setConnecting(true);
    try {
      await connect(port);
    } catch {
      // Error surfaces via the store.
    } finally {
      setConnecting(false);
    }
  };

  const handleConnectSelected = () => {
    const entry = ports.find((e) => e.key === selectedKey);
    if (entry) void doConnect(entry.port);
  };

  const handleAddDevice = async () => {
    setError(null);
    try {
      await Ppk2Client.requestPort();
      // Ensure the freshly authorized port is in the list.
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // User dismissing the picker throws — that's not an error.
      if (!/no port selected/i.test(message) && !/cancel/i.test(message)) {
        setError(message);
      }
    }
  };

  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="landing-hero">
          <div className="landing-logo" aria-hidden="true">
            <svg viewBox="0 0 48 48" width="48" height="48">
              <path
                d="M26 4 8 28h12l-4 16 20-26H24l2-14Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <h1>Power Profiler App</h1>
          <p className="landing-tagline">
            A browser-based client for Nordic Semiconductor power profilers. No
            drivers, no backend — just Web Serial.
          </p>
        </div>

        <div className="landing-card">
          <div className="landing-card-head">
            <h2>Available devices</h2>
          </div>

          {!supported && (
            <div className="landing-warning">
              <strong>Web Serial not available.</strong> Please open this page
              in a Chromium-based browser (Chrome, Edge, Opera) over HTTPS or
              localhost.
            </div>
          )}

          {supported && !scanning && ports.length === 0 && (
            <div className="landing-empty">
              <div className="landing-empty-icon" aria-hidden="true">
                🔌
              </div>
              <div>
                <div className="landing-empty-title">
                  No authorized devices yet
                </div>
                <p>
                  Plug in a Power Profiler Kit II and click
                  <strong> Add a device… </strong>
                  to grant this page access.
                </p>
              </div>
            </div>
          )}

          {supported && ports.length > 0 && (
            <ul
              className="device-list"
              role="radiogroup"
              aria-label="Available devices"
            >
              {ports.map((entry) => {
                const isActive = selectedKey === entry.key;
                return (
                  <li key={entry.key}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      className={`device-row ${isActive ? "active" : ""}`}
                      onClick={() => setSelectedKey(entry.key)}
                      onDoubleClick={() => void doConnect(entry.port)}
                      title="Double-click to connect"
                    >
                      <div className="device-badge">PPK2</div>
                      <div className="device-body">
                        <div className="device-title">
                          Power Profiler Kit II
                        </div>
                        <div className="device-vendor">
                          Nordic Semiconductor
                        </div>
                        <div className="device-meta">{entry.label}</div>
                      </div>
                      <div className="device-check" aria-hidden="true">
                        {isActive ? "●" : "○"}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {error && supported && <div className="landing-warning">{error}</div>}

          <div className="landing-actions">
            <button
              className="secondary large"
              onClick={() => void handleAddDevice()}
              disabled={!supported || connecting}
            >
              Add a device…
            </button>
            <button
              className="primary large"
              onClick={handleConnectSelected}
              disabled={
                !supported || connecting || ports.length === 0 || !selectedKey
              }
            >
              {connecting ? "Connecting…" : "Connect selected"}
            </button>
          </div>
          <p className="landing-hint">
            “Add a device…” opens the browser's serial-port picker. Once
            granted, the device is remembered and appears in the list on future
            visits.
          </p>
        </div>

        <footer className="landing-footer">
          <span>
            Requires PPK2 firmware ≥ 1.2.4 · Data stays in your browser
          </span>
        </footer>
      </div>
    </div>
  );
}
