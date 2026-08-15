/**
 * PPK2 calibration modifiers.
 *
 * When the device receives the GetMetaData (0x19) opcode it responds with an
 * ASCII text blob terminated by the literal "END". The blob contains 5 sets
 * of per-range calibration values (R, GS, GI, O, S, I, UG) plus a hardware
 * identifier and version fields.
 *
 * Example line: "R0: 1031.64"
 */

const RANGES = 5;

export type ModifierKey = 'R' | 'GS' | 'GI' | 'O' | 'S' | 'I' | 'UG';

export interface Modifiers {
    /** Per-range shunt resistance (Ω). */
    R: Float64Array;
    /** Per-range gain squared coefficient. */
    GS: Float64Array;
    /** Per-range gain linear coefficient. */
    GI: Float64Array;
    /** Per-range ADC offset (LSB). */
    O: Float64Array;
    /** Per-range voltage-dependent offset (μA / V). */
    S: Float64Array;
    /** Per-range static offset (μA). */
    I: Float64Array;
    /** Per-range user gain multiplier (usually 1.0). */
    UG: Float64Array;
    /** Hardware string reported by the device (e.g. "PPK2"). */
    hw?: string;
    /** Reported calibration status. */
    calibrated?: string;
    /** ADC → volts scale factor: 1.8 V full-scale / 16384 counts / 10 (÷4 in code). */
    readonly adcMult: number;
}

export function defaultModifiers(): Modifiers {
    return {
        R: Float64Array.from([1031.64, 101.65, 10.15, 0.94, 0.043]),
        GS: Float64Array.from([1, 1, 1, 1, 1]),
        GI: Float64Array.from([1, 1, 1, 1, 1]),
        O: new Float64Array(RANGES),
        S: new Float64Array(RANGES),
        I: new Float64Array(RANGES),
        UG: Float64Array.from([1, 1, 1, 1, 1]),
        adcMult: 1.8 / 163_840,
    };
}

const KEY_PATTERN = /^([A-Z]+)(\d)?$/;

/**
 * Parse the metadata blob into a fully-populated Modifiers object.
 * Missing keys keep their defaults. Throws only if the blob is not text.
 */
export function parseMetadata(blob: string): Modifiers {
    const mods = defaultModifiers();
    const lines = blob.split(/\r?\n/);
    for (const line of lines) {
        if (!line || line === 'END') continue;
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const rawKey = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        const m = KEY_PATTERN.exec(rawKey);
        if (!m) continue;
        const [, keyName, indexStr] = m;

        if (keyName === 'HW') {
            mods.hw = value;
            continue;
        }
        if (keyName === 'Calibrated') {
            mods.calibrated = value;
            continue;
        }

        if (indexStr === undefined) continue;
        const rangeIdx = Number(indexStr);
        if (rangeIdx < 0 || rangeIdx >= RANGES) continue;

        const num = Number(value);
        if (!Number.isFinite(num)) continue;

        if (isModifierKey(keyName)) {
            mods[keyName][rangeIdx] = num;
        }
    }
    return mods;
}

function isModifierKey(key: string): key is ModifierKey {
    return (
        key === 'R' ||
        key === 'GS' ||
        key === 'GI' ||
        key === 'O' ||
        key === 'S' ||
        key === 'I' ||
        key === 'UG'
    );
}
