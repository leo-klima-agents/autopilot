/** Required smoke test (spec §Engineering): the URL round-trip must be exact —
 *  a shared link reproduces the identical run on a deterministic core. */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN,
  PRESETS,
  configFromHash,
  configToHash,
  decodeRunConfig,
  encodeRunConfig,
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

  it("hash payload is URL-safe base64 only", () => {
    expect(configToHash(DEFAULT_RUN)).toMatch(/^#run=[A-Za-z0-9_-]+$/);
  });

  it("rejects garbage hashes without throwing", () => {
    expect(configFromHash("#run=%%%")).toBeUndefined();
    expect(configFromHash("#run=aGVsbG8")).toBeUndefined(); // valid b64, not a config
    expect(configFromHash("#other")).toBeUndefined();
  });
});
