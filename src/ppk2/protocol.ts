/**
 * PPK2 serial protocol.
 *
 * The Power Profiler Kit II (PPK2) enumerates as a USB CDC ACM device
 * (Nordic VID 0x1915, PID 0xC00A). Commands are single-byte opcodes,
 * optionally followed by 1–2 payload bytes. Samples stream back as
 * fixed 4-byte little-endian frames (see sampleParser.ts).
 *
 * Opcodes reverse-engineered by IRNAS/ppk2-api-python and nordicsemi/
 * pc-nrfconnect-ppk. This file is the authoritative constants list.
 */

export const PPK2_USB_FILTER: SerialPortFilter = {
  usbVendorId: 0x1915,
  usbProductId: 0xc00a,
};

export const enum Opcode {
  NoOp = 0x00,
  TriggerSet = 0x01,
  AvgNumSet = 0x02,
  TriggerWindowSet = 0x03,
  TriggerIntervalSet = 0x04,
  TriggerSingleSet = 0x05,
  AverageStart = 0x06,
  AverageStop = 0x07,
  RangeSet = 0x08,
  LcdSet = 0x09,
  TriggerStop = 0x0a,
  DeviceRunningSet = 0x0c,
  RegulatorSet = 0x0d,
  SwitchPointDown = 0x0e,
  SwitchPointUp = 0x0f,
  SetPowerMode = 0x11,
  ResUserSet = 0x12,
  SpikeFilteringOn = 0x15,
  SpikeFilteringOff = 0x16,
  GetMetaData = 0x19,
  Reset = 0x20,
  SetUserGains = 0x25,
}

export type PowerMode = "source" | "ampere";

/**
 * Native PPK2 ADC rate — the hardware always samples at 100 kSa/s. Everything
 * slower is achieved by averaging N consecutive raw samples in the host
 * (see the worker's decimator). There is no firmware command to change the
 * ADC rate; both Nordic's official app and the IRNAS Python API do the same
 * thing.
 */
export const NATIVE_SAMPLE_RATE_HZ = 100_000;

/**
 * @deprecated Prefer the recorder's configured rate. Kept as an alias while
 *   the codebase transitions to a runtime-configurable sample rate.
 */
export const SAMPLE_RATE_HZ = NATIVE_SAMPLE_RATE_HZ;

export const SAMPLE_BYTES = 4;
export const VDD_MIN_MV = 800;
export const VDD_MAX_MV = 5000;

/**
 * User-selectable output sample rates. Each entry is achieved by averaging
 * `decimation` consecutive raw 100 kHz samples into one output sample.
 */
export interface SampleRatePreset {
  hz: number;
  decimation: number;
  label: string;
}

export const SAMPLE_RATE_PRESETS: readonly SampleRatePreset[] = [
  { hz: 100_000, decimation: 1, label: "100 kHz" },
  { hz: 50_000, decimation: 2, label: "50 kHz" },
  { hz: 10_000, decimation: 10, label: "10 kHz" },
  { hz: 1_000, decimation: 100, label: "1 kHz" },
  { hz: 100, decimation: 1_000, label: "100 Hz" },
  { hz: 10, decimation: 10_000, label: "10 Hz" },
  { hz: 1, decimation: 100_000, label: "1 Hz" },
];

export const DEFAULT_SAMPLE_RATE_HZ = 100_000;

export function decimationForRate(hz: number): number {
  const preset = SAMPLE_RATE_PRESETS.find((p) => p.hz === hz);
  if (preset) return preset.decimation;
  // Fallback: nearest integer decimation.
  return Math.max(1, Math.round(NATIVE_SAMPLE_RATE_HZ / hz));
}

/**
 * Convert a source voltage in mV (800..5000) into the two payload bytes
 * that follow the RegulatorSet opcode. Mirrors the algorithm in the
 * IRNAS Python API, which itself was derived from PPK2 firmware behavior.
 */
export function encodeSourceVoltage(mv: number): [number, number] {
  const clamped = Math.max(VDD_MIN_MV, Math.min(VDD_MAX_MV, Math.round(mv)));
  const offset = 32;
  const diff = clamped - VDD_MIN_MV + offset;
  const b1 = 3 + Math.floor(diff / 256);
  const b2 = diff % 256;
  return [b1, b2];
}

export function cmd(...bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

// -- High level command builders ------------------------------------------------

export const buildGetMetadata = () => cmd(Opcode.GetMetaData);
export const buildReset = () => cmd(Opcode.Reset);
export const buildStart = () => cmd(Opcode.AverageStart);
export const buildStop = () => cmd(Opcode.AverageStop);
export const buildSpikeFilter = (on: boolean) =>
  cmd(on ? Opcode.SpikeFilteringOn : Opcode.SpikeFilteringOff);

export function buildSetVoltage(mv: number): Uint8Array {
  const [b1, b2] = encodeSourceVoltage(mv);
  return cmd(Opcode.RegulatorSet, b1, b2);
}

export function buildSetPowerMode(mode: PowerMode): Uint8Array {
  // Payload: 1 = ampere meter, 2 = source meter
  return cmd(Opcode.SetPowerMode, mode === "ampere" ? 1 : 2);
}

export function buildToggleDut(on: boolean): Uint8Array {
  // DEVICE_RUNNING_SET, 1=on, 0=off
  return cmd(Opcode.DeviceRunningSet, on ? 1 : 0);
}
