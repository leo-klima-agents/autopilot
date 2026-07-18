/**
 * `pnpm fixtures` entry point: writes the differential fixture vectors into
 * contracts/test/differential/fixtures/ (created if missing). Fully
 * deterministic — fixed seeds, sorted keys — so re-running produces
 * byte-identical files.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildCapBurnFixtures,
  buildProRataFixtures,
  buildSchedulerFixtures,
  buildWaterFillingFixtures,
} from "./generators.js";
import { stringifyFixtureFile, type FixtureFile } from "./serialize.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** contracts/test/differential/fixtures at the repo root. */
export const FIXTURES_DIR = resolve(HERE, "../../../../contracts/test/differential/fixtures");

/** Family seeds — fixed forever; changing them invalidates the Solidity twin. */
export const FIXTURE_SEEDS = {
  proRata: 0x5eed_0001n,
  capBurn: 0x5eed_0002n,
  waterFilling: 0x5eed_0003n,
  scheduler: 0x5eed_0004n,
} as const;

/** Builds all four fixture families with their fixed seeds. */
export function buildAllFixtureFiles(): { filename: string; file: FixtureFile<unknown> }[] {
  return [
    { filename: "pro-rata-revenue.json", file: buildProRataFixtures(FIXTURE_SEEDS.proRata) },
    { filename: "cap-burn.json", file: buildCapBurnFixtures(FIXTURE_SEEDS.capBurn) },
    {
      filename: "water-filling.json",
      file: buildWaterFillingFixtures(FIXTURE_SEEDS.waterFilling),
    },
    {
      filename: "cooldown-scheduler.json",
      file: buildSchedulerFixtures(FIXTURE_SEEDS.scheduler),
    },
  ];
}

/** Writes every fixture family to `outDir`. */
export function emitFixtures(outDir: string = FIXTURES_DIR): void {
  mkdirSync(outDir, { recursive: true });
  for (const { filename, file } of buildAllFixtureFiles()) {
    const path = resolve(outDir, filename);
    writeFileSync(path, stringifyFixtureFile(file), "utf8");
    console.log(`fixtures: wrote ${path} (${file.cases.length} cases)`);
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) emitFixtures();
