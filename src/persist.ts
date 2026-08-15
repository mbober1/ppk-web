/**
 * Tiny localStorage helpers. Everything is wrapped in try/catch so a
 * disabled/full/broken storage never breaks the app.
 */

export function loadJson<T>(
  key: string,
  validate: (value: unknown) => T | null,
): T | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed);
  } catch {
    return null;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / serialization / disabled — silently ignore */
  }
}

export function removeKey(key: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
