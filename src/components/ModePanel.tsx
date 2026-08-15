import { useUiStore } from '../store';
import { VDD_MAX_MV, VDD_MIN_MV } from '../ppk2/protocol';

export function ModePanel(): JSX.Element {
    const connected = useUiStore((s) => s.connected);
    const mode = useUiStore((s) => s.mode);
    const voltage = useUiStore((s) => s.voltageMv);
    const dutOn = useUiStore((s) => s.dutOn);
    const setMode = useUiStore((s) => s.setMode);
    const setVoltage = useUiStore((s) => s.setVoltageMv);
    const setDut = useUiStore((s) => s.setDut);

    return (
        <div className="panel">
            <h2>Mode</h2>
            <div className="field">
                <label htmlFor="mode">Meter</label>
                <select
                    id="mode"
                    value={mode}
                    disabled={!connected}
                    onChange={(e) => void setMode(e.target.value as 'source' | 'ampere')}
                >
                    <option value="source">Source meter</option>
                    <option value="ampere">Ampere meter</option>
                </select>
            </div>
            <div className="field">
                <label htmlFor="vdd">V<sub>DD</sub> (mV)</label>
                <input
                    id="vdd"
                    type="number"
                    min={VDD_MIN_MV}
                    max={VDD_MAX_MV}
                    step={100}
                    value={voltage}
                    disabled={!connected}
                    onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) void setVoltage(v);
                    }}
                />
            </div>
            <input
                type="range"
                min={VDD_MIN_MV}
                max={VDD_MAX_MV}
                step={100}
                value={voltage}
                disabled={!connected}
                onChange={(e) => void setVoltage(Number(e.target.value))}
                style={{ width: '100%' }}
            />
            <div className="field" style={{ marginTop: 8 }}>
                <label>DUT power</label>
                <button
                    className={dutOn ? 'primary' : ''}
                    disabled={!connected}
                    onClick={() => void setDut(!dutOn)}
                >
                    {dutOn ? 'ON' : 'OFF'}
                </button>
            </div>
        </div>
    );
}
