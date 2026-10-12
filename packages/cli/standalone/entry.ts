// Entry point for the single-file binary (Homebrew / GitHub releases).
// Built with `bun build --compile` by scripts/build-binaries.mjs, which first
// generates embedded-dashboard.gen.ts from the built dashboard.
import { registerEmbeddedDashboard } from "../src/dashboard-assets.js";
import { main } from "../src/cli.js";
import { files } from "./embedded-dashboard.gen.js";

registerEmbeddedDashboard(files);
await main();
