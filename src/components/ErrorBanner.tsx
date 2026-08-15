import { useUiStore } from '../store';

export function ErrorBanner(): JSX.Element | null {
    const error = useUiStore((s) => s.error);
    const setError = useUiStore((s) => s.setError);
    if (!error) return null;
    return (
        <div className="banner">
            <span>⚠ {error}</span>
            <button className="danger" onClick={() => setError(null)}>
                Dismiss
            </button>
        </div>
    );
}
