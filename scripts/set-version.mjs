#!/usr/bin/env node
// Sets the version of every package and the CLI's version constant.
//
//   node scripts/set-version.mjs 0.2.0
//   node scripts/set-version.mjs --check v0.2.0   # CI: fail if versions don't match the tag

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["packages/core/package.json", "packages/cli/package.json", "packages/dashboard/package.json"];
const VERSION_TS = "packages/cli/src/version.ts";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const args = process.argv.slice(2);
const check = args[0] === "--check";
const version = (check ? args[1] : args[0])?.replace(/^v/, "");

if (!version || !SEMVER.test(version)) {
  console.error("Usage: set-version.mjs [--check] <semver>");
  process.exit(1);
}

const versionTsContent = `// Kept in sync with package.json by scripts/set-version.mjs.\nexport const VERSION = "${version}";\n`;

if (check) {
  const mismatches = PACKAGES.map((p) => [p, JSON.parse(readFileSync(join(ROOT, p), "utf8")).version]).filter(
    ([, v]) => v !== version,
  );
  const ts = /VERSION = "([^"]+)"/.exec(readFileSync(join(ROOT, VERSION_TS), "utf8"))?.[1];
  if (ts !== version) mismatches.push([VERSION_TS, ts]);
  if (mismatches.length) {
    for (const [file, v] of mismatches) console.error(`${file}: ${v} (expected ${version})`);
    console.error("Run `node scripts/set-version.mjs <version>` and commit before tagging.");
    process.exit(1);
  }
  console.log(`All packages are at ${version}.`);
  process.exit(0);
}

for (const p of PACKAGES) {
  const path = join(ROOT, p);
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}
writeFileSync(join(ROOT, VERSION_TS), versionTsContent);
console.log(`Set version ${version}. Next:\n  git commit -am "Release v${version}" && git tag v${version} && git push --follow-tags`);
