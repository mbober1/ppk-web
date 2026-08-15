/**
 * Decode PPK2 sample frames.
 *
 * Each sample is a 4-byte little-endian 32-bit word packed as:
 *   bits  0..13  → 14-bit ADC count
 *   bits 14..16  → current range (0..4, 5 shunt ranges)
 *   bits 17..23  → reserved
 *   bits 24..31  → 8 digital pin states (D0 in bit 0)
 *
 * Conversion to μA uses the modifiers loaded from the device:
 *   result_no_gain = (adc*4 - O[r]) * adcMult / R[r]
 *   ua = UG[r] * (rn * (GS[r]*rn + GI[r]) + (S[r]*Vdd + I[r])) * 1e6
 *
 * A rolling spike filter smooths the samples immediately after a range
 * change (this matches the behavior of the official app and IRNAS API).
 */

import type { Modifiers } from './modifiers';

const RANGE_COUNT = 5;
const ADC_MASK = 0x3fff; // 14 bits
const RANGE_MASK = 0x7 << 14;
const RANGE_SHIFT = 14;
const LOGIC_SHIFT = 24;
const LOGIC_MASK = 0xff << LOGIC_SHIFT;

export interface ParserState {
    rollingAvg: number | null;
    rollingAvg4: number | null;
    prevRange: number;
    afterSpike: number;
}

export function newParserState(): ParserState {
    return {
        rollingAvg: null,
        rollingAvg4: null,
        prevRange: -1,
        afterSpike: 0,
    };
}

const SPIKE_ALPHA = 0.18;
const SPIKE_ALPHA_R4 = 0.06;
const SPIKE_FILTER_SAMPLES = 3;

/**
 * Decode a chunk of raw serial bytes into current (μA) and digital pin arrays.
 * `leftover` handles cases where the previous chunk ended mid-sample.
 * Returns the leftover bytes for the next call.
 */
export function parseChunk(
    chunk: Uint8Array,
    leftover: Uint8Array,
    state: ParserState,
    mods: Modifiers,
    vddV: number,
    outCurrent: Float32Array,
    outDigital: Uint8Array,
): { produced: number; leftover: Uint8Array } {
    // Concatenate leftover with the new chunk. In steady state leftover is 0
    // or a small number of bytes, so this allocation is negligible.
    let buf: Uint8Array;
    if (leftover.length === 0) {
        buf = chunk;
    } else {
        buf = new Uint8Array(leftover.length + chunk.length);
        buf.set(leftover, 0);
        buf.set(chunk, leftover.length);
    }

    const totalSamples = Math.floor(buf.length / 4);
    let produced = 0;

    // Use a DataView for fast little-endian reads.
    const view = new DataView(buf.buffer, buf.byteOffset, totalSamples * 4);

    for (let i = 0; i < totalSamples; i++) {
        const word = view.getUint32(i * 4, true);
        const rangeRaw = (word & RANGE_MASK) >>> RANGE_SHIFT;
        const range = rangeRaw >= RANGE_COUNT ? RANGE_COUNT - 1 : rangeRaw;
        const adc = (word & ADC_MASK) * 4;
        const logic = (word & LOGIC_MASK) >>> LOGIC_SHIFT;

        const ua = adcToMicroAmps(adc, range, mods, vddV);
        const filtered = applySpikeFilter(ua, range, state);

        outCurrent[produced] = filtered;
        outDigital[produced] = logic;
        produced++;
    }

    const consumed = totalSamples * 4;
    const remaining = buf.length - consumed;
    const nextLeftover = remaining > 0 ? buf.slice(consumed) : EMPTY;
    return { produced, leftover: nextLeftover };
}

const EMPTY = new Uint8Array(0);

function adcToMicroAmps(adc: number, range: number, m: Modifiers, vddV: number): number {
    const rn = (adc - m.O[range]) * (m.adcMult / m.R[range]);
    const ua = m.UG[range] * (rn * (m.GS[range] * rn + m.GI[range]) + (m.S[range] * vddV + m.I[range]));
    // Clamp small negatives to zero — PPK2 file format assumes non-negative μA.
    const scaled = ua * 1_000_000;
    return scaled < 0.2 ? 0 : scaled;
}

function applySpikeFilter(sample: number, range: number, s: ParserState): number {
    if (s.rollingAvg === null) s.rollingAvg = sample;
    else s.rollingAvg = SPIKE_ALPHA * sample + (1 - SPIKE_ALPHA) * s.rollingAvg;

    if (s.rollingAvg4 === null) s.rollingAvg4 = sample;
    else s.rollingAvg4 = SPIKE_ALPHA_R4 * sample + (1 - SPIKE_ALPHA_R4) * s.rollingAvg4;

    if (s.prevRange < 0) s.prevRange = range;

    let out = sample;
    if (s.prevRange !== range) {
        s.afterSpike = SPIKE_FILTER_SAMPLES;
    }
    if (s.afterSpike > 0) {
        out = range === 4 ? s.rollingAvg4 : s.rollingAvg;
        s.afterSpike--;
    }
    s.prevRange = range;
    return out;
}
