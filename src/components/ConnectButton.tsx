import { useUiStore } from "../store";

export function ConnectButton(): JSX.Element {
  const connected = useUiStore((s) => s.connected);
  const connect = useUiStore((s) => s.connect);
  const disconnect = useUiStore((s) => s.disconnect);

  if (connected) {
    return (
      <button className="danger" onClick={() => void disconnect()}>
        Disconnect
      </button>
    );
  }
  return (
    <button
      className="primary"
      onClick={() => void connect().catch(() => undefined)}
    >
      Connect profiler
    </button>
  );
}
