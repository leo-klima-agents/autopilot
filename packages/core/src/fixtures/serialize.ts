/**
 * JSON serialization for fixture vectors: all bigints become decimal
 * strings, Maps become plain objects with sorted keys, so output is
 * deterministic byte-for-byte and consumable from Solidity test harnesses.
 */

/** Recursively converts bigints to decimal strings and Maps to sorted objects. */
export function toJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const key of [...value.keys()].map(String).sort()) {
      out[key] = toJsonValue((value as Map<unknown, unknown>).get(key));
    }
    return out;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonValue(v);
    return out;
  }
  return value;
}

/** A named family of fixture cases. */
export interface FixtureFile<TCase> {
  name: string;
  cases: TCase[];
}

/** Deterministic pretty-printed JSON (trailing newline included). */
export function stringifyFixtureFile(file: FixtureFile<unknown>): string {
  return `${JSON.stringify(toJsonValue(file), null, 2)}\n`;
}
