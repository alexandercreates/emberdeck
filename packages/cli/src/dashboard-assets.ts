import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the studio gets the dashboard files from: a directory on disk (npm
 * package, monorepo) or an in-memory map embedded into the single-file binary.
 */
export interface DashboardAssets {
  readonly source: string;
  /** Returns the file for a URL path, or undefined if it doesn't exist. */
  get(urlPath: string): Promise<{ data: Buffer; contentType: string } | undefined>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

export const contentTypeFor = (path: string): string => MIME[extname(path)] ?? "application/octet-stream";

export function directoryAssets(dir: string): DashboardAssets {
  const root = resolve(dir);
  return {
    source: root,
    async get(urlPath) {
      const file = normalize(join(root, decodeURIComponent(urlPath)));
      if (!file.startsWith(root + sep)) return undefined;
      const isFile = await stat(file).then((s) => s.isFile()).catch(() => false);
      if (!isFile) return undefined;
      return { data: await readFile(file), contentType: contentTypeFor(file) };
    },
  };
}

/** Files keyed by relative path (`index.html`, `assets/main.js`), base64 encoded. */
export type EmbeddedFiles = Record<string, string>;

export function embeddedAssets(files: EmbeddedFiles): DashboardAssets {
  const decoded = new Map(Object.entries(files).map(([path, b64]) => [path, Buffer.from(b64, "base64")]));
  return {
    source: "embedded",
    async get(urlPath) {
      const key = decodeURIComponent(urlPath).replace(/^\/+/, "");
      const data = decoded.get(key);
      return data ? { data, contentType: contentTypeFor(key) } : undefined;
    },
  };
}

let embedded: DashboardAssets | undefined;

/** Called by the standalone binary entry point before the CLI starts. */
export function registerEmbeddedDashboard(files: EmbeddedFiles): void {
  embedded = embeddedAssets(files);
}

/**
 * Resolution order: explicit dir → EMBERDECK_DASHBOARD_DIR → embedded (binary)
 * → dist/dashboard (npm package) → packages/dashboard/dist (monorepo dev).
 */
export function resolveDashboard(explicitDir?: string): DashboardAssets | undefined {
  const has = (p?: string): p is string => !!p && existsSync(join(p, "index.html"));
  if (has(explicitDir)) return directoryAssets(explicitDir);
  if (has(process.env.EMBERDECK_DASHBOARD_DIR)) return directoryAssets(process.env.EMBERDECK_DASHBOARD_DIR);
  if (embedded) return embedded;
  let here: string | undefined;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
  for (const candidate of [join(here, "dashboard"), join(here, "..", "..", "dashboard", "dist")]) {
    if (has(candidate)) return directoryAssets(candidate);
  }
  return undefined;
}
