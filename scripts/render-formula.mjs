#!/usr/bin/env node
// Renders the Homebrew formula from the template and a checksums.txt.
//
//   node scripts/render-formula.mjs --checksums dist-bin/checksums.txt --out Formula/emberdeck.rb

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    checksums: { type: "string", default: join(ROOT, "dist-bin/checksums.txt") },
    version: { type: "string" },
    out: { type: "string" },
  },
});

const version =
  values.version ?? JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")).version;

const sums = {};
for (const line of readFileSync(values.checksums, "utf8").split("\n")) {
  const match = /^([a-f0-9]{64})\s+emberdeck-v([^-]+(?:-[^-]+)*?)-(darwin|linux)-(arm64|x64)\.tar\.gz$/.exec(line.trim());
  if (!match) continue;
  if (match[2] !== version) throw new Error(`checksums.txt is for v${match[2]}, expected v${version}`);
  sums[`sha256_${match[3]}_${match[4]}`] = match[1];
}

let formula = readFileSync(join(ROOT, "packaging/homebrew/emberdeck.rb.tmpl"), "utf8").replaceAll(
  "{{version}}",
  version,
);
const missing = [];
formula = formula.replace(/\{\{(sha256_[a-z0-9_]+)\}\}/g, (_m, key) => {
  if (!sums[key]) missing.push(key);
  return sums[key] ?? "";
});
if (missing.length) throw new Error(`Missing checksums for: ${missing.join(", ")}`);

if (values.out) {
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, formula);
  console.log(`Wrote ${values.out}`);
} else {
  process.stdout.write(formula);
}
