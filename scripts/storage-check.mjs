#!/usr/bin/env node
/**
 * Storage discipline checks (brief §4.2), CI-enforced:
 *   rule 1 — namespaced structs are append-only: previously recorded fields must keep
 *            index, name and type; new fields only at the end. Baseline:
 *            contracts/storage-layout.lock.json (update with `write` after review).
 *   rule 2 — no facet declares contract-level state variables (forge inspect
 *            storageLayout must be empty for every facet).
 *   rule 3 — every namespace string registered exactly once, and every *_SLOT constant
 *            equals the ERC-7201 formula for its registered id.
 *
 * Usage: node scripts/storage-check.mjs [check|write]
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = join(root, "contracts");
const storageFile = join(contractsDir, "src/libraries/LibVaultStorage.sol");
const lockPath = join(contractsDir, "storage-layout.lock.json");
const mode = process.argv[2] ?? "check";
const errors = [];

const src = readFileSync(storageFile, "utf8");

// ---------------------------------------------------------------------------
// rule 3a: namespace ids unique (LibVaultStorage + DiamondInit guard namespace)
// ---------------------------------------------------------------------------
const initSrc = readFileSync(join(contractsDir, "src/init/DiamondInit.sol"), "utf8");
const nsIds = [...(src + initSrc).matchAll(/erc7201:([a-z0-9.\-]+)/g)].map((m) => m[1]);
const dupes = nsIds.filter((n, i) => nsIds.indexOf(n) !== i);
if (dupes.length) errors.push(`duplicate namespace ids: ${[...new Set(dupes)].join(", ")}`);

// ---------------------------------------------------------------------------
// rule 3b: slot constants match the ERC-7201 formula (keccak via `cast`)
// ---------------------------------------------------------------------------
function erc7201(id) {
  const keccak = (hexOrString) =>
    execSync(`cast keccak ${JSON.stringify(hexOrString)}`, { encoding: "utf8" }).trim();
  const inner = BigInt(keccak(id)) - 1n;
  const encoded = "0x" + inner.toString(16).padStart(64, "0");
  const outer = BigInt(keccak(encoded));
  const masked = outer & ~0xffn;
  return "0x" + masked.toString(16).padStart(64, "0");
}

// pair each `/// @dev erc7201:<id>` with the constant on the following line
for (const file of [src, initSrc]) {
  const pairRe = /erc7201:([a-z0-9.\-]+)[^\n]*\n\s*bytes32 internal constant (\w+) = (0x[0-9a-fA-F]{64});/g;
  for (const m of file.matchAll(pairRe)) {
    const [, id, name, value] = m;
    const expected = erc7201(id);
    if (value.toLowerCase() !== expected.toLowerCase()) {
      errors.push(`${name}: slot ${value} != erc7201("${id}") = ${expected}`);
    }
  }
}

// ---------------------------------------------------------------------------
// rule 2: zero contract-level storage in every facet
// ---------------------------------------------------------------------------
const facetFiles = [
  ...readdirSync(join(contractsDir, "src/facets")).filter((f) => f.endsWith(".sol")),
  ...readdirSync(join(contractsDir, "src/facets/protocol")).map((f) => f),
].filter((f) => f.endsWith(".sol"));
for (const f of facetFiles) {
  const name = f.replace(".sol", "");
  const layout = JSON.parse(
    execSync(`forge inspect ${name} storageLayout --json`, { cwd: contractsDir, encoding: "utf8" })
  );
  const slots = layout.storage ?? [];
  if (slots.length > 0) {
    errors.push(`facet ${name} declares contract-level storage: ${slots.map((s) => s.label).join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// rule 1: append-only struct layouts in LibVaultStorage
// ---------------------------------------------------------------------------
function parseStructs(source) {
  const structs = {};
  const re = /struct (\w+) \{([\s\S]*?)\n    \}/g;
  for (const m of source.matchAll(re)) {
    const [, name, body] = m;
    const fields = [...body.matchAll(/^\s*([\w()\[\]=>. ]+?)\s+(\w+);/gm)].map(([, type, field]) => ({
      type: type.trim(),
      name: field,
    }));
    structs[name] = fields;
  }
  return structs;
}

const current = parseStructs(src);
if (mode === "write") {
  writeFileSync(lockPath, JSON.stringify({ schemaVersion: 1, structs: current }, null, 2) + "\n");
  console.log(`wrote ${lockPath}`);
} else if (!existsSync(lockPath)) {
  errors.push("storage-layout.lock.json missing — run `node scripts/storage-check.mjs write`");
} else {
  const locked = JSON.parse(readFileSync(lockPath, "utf8")).structs;
  for (const [name, lockedFields] of Object.entries(locked)) {
    const cur = current[name];
    if (!cur) {
      errors.push(`struct ${name} was deleted (deprecate fields with __deprecated_*, never delete structs)`);
      continue;
    }
    lockedFields.forEach((lf, i) => {
      const cf = cur[i];
      const renamedDeprecated = cf && cf.type === lf.type && cf.name === `__deprecated_${lf.name}`;
      if (!cf || cf.type !== lf.type || (cf.name !== lf.name && !renamedDeprecated)) {
        errors.push(
          `struct ${name} field #${i} changed: locked ${lf.type} ${lf.name}, now ${cf ? `${cf.type} ${cf.name}` : "missing"} — layout is append-only`
        );
      }
    });
  }
  // new structs are fine but must be locked in the same PR
  for (const name of Object.keys(current)) {
    if (!locked[name]) errors.push(`struct ${name} is new — run \`write\` to lock it in this PR`);
  }
}

if (errors.length) {
  console.error("storage-check FAILED:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("storage-check OK");
