import { useEffect } from "react";

import { ChartMinimap } from "./components/ChartMinimap";
import { ChartPanel } from "./components/ChartPanel";
import { ConnectButton } from "./components/ConnectButton";
import { Controls } from "./components/Controls";
import { ErrorBanner } from "./components/ErrorBanner";
import { ExportPanel } from "./components/ExportPanel";
import { LandingPage } from "./components/LandingPage";
import { LiveChart } from "./components/LiveChart";
import { ModePanel } from "./components/ModePanel";
import { RecentPanel } from "./components/RecentPanel";
import { StatsPanel } from "./components/StatsPanel";
import { Ppk2Client } from "./ppk2/client";
import { useUiStore } from "./store";

export function App(): JSX.Element {
  const connected = useUiStore((s) => s.connected);
  const sampling = useUiStore((s) => s.sampling);
  const setError = useUiStore((s) => s.setError);
  const selectedRecentId = useUiStore((s) => s.selectedRecentId);

  useEffect(() => {
    if (!Ppk2Client.isSupported()) {
      setError(
        "Web Serial API is not available. Please use a Chromium-based browser (Chrome, Edge, Opera) over HTTPS or localhost.",
      );
    }
  }, [setError]);

  // Keyboard shortcuts: space toggles sampling.
  useEffect(() => {
    const store = useUiStore.getState;
    const onKey = (ev: KeyboardEvent) => {
      if (
        ev.target instanceof HTMLInputElement ||
        ev.target instanceof HTMLSelectElement
      )
        return;
      if (ev.code === "Space") {
        ev.preventDefault();
        const s = store();
        if (!s.connected) return;
        if (s.sampling) void s.stop();
        else void s.start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!connected) {
    return <LandingPage />;
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Power Profiler App</h1>
        <div className="status">
          <span
            className={`dot ${sampling ? "sampling" : connected ? "on" : ""}`}
          />
          <span>
            {sampling ? "Sampling" : connected ? "Connected" : "Disconnected"}
          </span>
          <ConnectButton />
        </div>
      </header>
      <div className="main">
        <aside className="sidebar">
          <ModePanel />
          <Controls />
          <ChartPanel />
          <RecentPanel />
          <ExportPanel />
        </aside>
        <section className="content">
          <ErrorBanner />
          <div className="chart-wrap">
            <LiveChart />
          </div>
          {selectedRecentId !== null && <ChartMinimap />}
          <StatsPanel />
        </section>
      </div>
    </div>
  );
}
