// Copies the built dashboard into dist/dashboard so it ships with the npm package.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "dashboard", "dist");
const target = join(here, "..", "dist", "dashboard");

if (!existsSync(source)) {
  console.error("Dashboard is not built. Run `pnpm build` at the repository root first.");
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`Bundled dashboard into ${target}`);
