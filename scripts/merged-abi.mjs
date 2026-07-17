#!/usr/bin/env node
/**
 * Assembles the diamond's merged ABI from facets.json + forge artifacts (brief §5, §10.6):
 * the single ABI a caller loads against the diamond address (viem typed clients, Basescan
 * "Custom ABI", Safe transaction builder). Written to contracts/out-merged-abi.json.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = join(root, "contracts");
const manifest = JSON.parse(readFileSync(join(contractsDir, "facets.json"), "utf8"));

const merged = [];
const seen = new Set();

for (const facet of manifest.facets) {
  // AeroFacet draft + MockAeroFacet share the protocol surface with AerodromeFacet;
  // only include facets marked deployed to avoid duplicate/misleading entries.
  if (!facet.deployed) continue;
  const abi = JSON.parse(
    execSync(`forge inspect ${facet.name} abi --json`, { cwd: contractsDir, encoding: "utf8" })
  );
  for (const item of abi) {
    const key = item.type === "function" || item.type === "event" || item.type === "error"
      ? `${item.type}:${item.name}(${(item.inputs ?? []).map((i) => i.type).join(",")})`
      : item.type;
    if (item.type === "constructor" || item.type === "fallback" || item.type === "receive") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
}

const out = join(contractsDir, "out-merged-abi.json");
writeFileSync(out, JSON.stringify(merged, null, 2) + "\n");
console.log(`wrote ${out}: ${merged.length} ABI items from ${manifest.facets.filter((f) => f.deployed).length} deployed facets`);
