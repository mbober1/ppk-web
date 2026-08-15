import { useUiStore } from '../store';

function fmtCurrent(ua: number): string {
    if (!Number.isFinite(ua)) return '—';
    if (Math.abs(ua) >= 1_000_000) return `${(ua / 1_000_000).toFixed(3)} A`;
    if (Math.abs(ua) >= 1_000) return `${(ua / 1_000).toFixed(3)} mA`;
    return `${ua.toFixed(2)} µA`;
}

function fmtCharge(uc: number): string {
    // µC → mAh: 1 mAh = 3600 mC = 3_600_000 µC
    const mah = uc / 3_600_000;
    if (Math.abs(mah) >= 1) return `${mah.toFixed(4)} mAh`;
    return `${(uc / 1000).toFixed(2)} mC`;
}

function fmtDuration(s: number): string {
    if (s < 60) return `${s.toFixed(1)} s`;
    const min = Math.floor(s / 60);
    const rem = s - min * 60;
    return `${min}m ${rem.toFixed(1)}s`;
}

export function StatsPanel(): JSX.Element {
    const stats = useUiStore((s) => s.stats);
    return (
        <div className="stats">
            <div className="stat">
                <div className="label">Average</div>
                <div className="value">{fmtCurrent(stats.avgUa)}</div>
            </div>
            <div className="stat">
                <div className="label">Min</div>
                <div className="value">{fmtCurrent(stats.minUa)}</div>
            </div>
            <div className="stat">
                <div className="label">Max</div>
                <div className="value">{fmtCurrent(stats.maxUa)}</div>
            </div>
            <div className="stat">
                <div className="label">Charge</div>
                <div className="value">{fmtCharge(stats.chargeUc)}</div>
            </div>
            <div className="stat">
                <div className="label">Duration</div>
                <div className="value">{fmtDuration(stats.durationS)}</div>
            </div>
        </div>
    );
}
