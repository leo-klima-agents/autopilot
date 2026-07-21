/** Required smoke test (spec §Engineering): the URL round-trip must be exact;
 *  a shared link reproduces the identical run on a deterministic core. */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN,
  PRESETS,
  configFromHash,
  configToHash,
  decodeRunConfig,
  encodeRunConfig,
  type RunConfig,
} from "../src/lib/runConfig.js";

describe("run-config URL serialization", () => {
  it("round-trips the default config exactly", () => {
    expect(decodeRunConfig(encodeRunConfig(DEFAULT_RUN))).toEqual(DEFAULT_RUN);
  });

  it("round-trips every preset through the full hash", () => {
    for (const preset of PRESETS) {
      const hash = configToHash(preset.config);
      expect(configFromHash(hash)).toEqual(preset.config);
    }
  });

  it("round-trips every logbook entry through the full hash", async () => {
    const { LOGBOOK } = await import("../src/components/Logbook.js");
    expect(LOGBOOK.length).toBeGreaterThan(0);
    for (const entry of LOGBOOK) {
      const hash = configToHash(entry.config);
      expect(configFromHash(hash), entry.id).toEqual(entry.config);
    }
  });

  it("hash payload is URL-safe base64 only", () => {
    expect(configToHash(DEFAULT_RUN)).toMatch(/^#run=[A-Za-z0-9_-]+$/);
  });

  it("rejects garbage hashes without throwing", () => {
    expect(configFromHash("#run=%%%")).toBeUndefined();
    expect(configFromHash("#run=aGVsbG8")).toBeUndefined(); // valid b64, not a config
    expect(configFromHash("#other")).toBeUndefined();
  });

  it("validates the data variant at the decode boundary", () => {
    const withData = (data: unknown) =>
      configToHash({ ...DEFAULT_RUN, data: data as RunConfig["data"] });
    // an unknown process kind must fall back (never reach the worker throw)
    expect(configFromHash(withData({ ...DEFAULT_RUN.data, process: "growth" }))).toBeUndefined();
    // malformed window fields invalidate the config rather than being
    // silently dropped (a fractional offset used to be floored to zero)
    expect(configFromHash(withData({ kind: "historical", endOffsetWeeks: 0.5 }))).toBeUndefined();
    expect(configFromHash(withData({ kind: "historical", endOffsetWeeks: -3 }))).toBeUndefined();
    expect(configFromHash(withData({ kind: "historical", windowEndTs: "soon" }))).toBeUndefined();
    // well-formed variants pass
    expect(configFromHash(withData({ kind: "historical", endOffsetWeeks: 4 }))).toBeDefined();
    expect(configFromHash(withData({ kind: "historical", windowEndTs: 1_741_219_200 }))).toBeDefined();
  });

  it("decodes legacy synthetic links (no gen stamp, legacy kinds)", () => {
    const legacy = {
      ...DEFAULT_RUN,
      data: { kind: "synthetic", seed: "7", poolCount: 6, epochCount: 20, process: "regime" },
    } as RunConfig;
    const decoded = configFromHash(configToHash(legacy));
    expect(decoded).toEqual(legacy);
    // the missing stamp is what the App's version banner keys on
    expect(decoded?.data.kind === "synthetic" && decoded.data.gen).toBeUndefined();
  });
});
