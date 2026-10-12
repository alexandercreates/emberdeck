import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EmberdeckError, isEmberdeckError, type Workspace } from "@emberdeck/core";

/**
 * Local API + dashboard server for `emberdeck studio`.
 *
 * Security model: binds to 127.0.0.1 only, requires a random per-session
 * token on every API call, and rejects requests whose Host/Origin is not the
 * local server (protects against DNS rebinding and cross-site requests).
 */

export interface StudioOptions {
  port?: number;
  host?: string;
  token?: string;
  dashboardDir?: string;
}

export interface StudioServer {
  server: Server;
  url: string;
  token: string;
  close(): Promise<void>;
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

type Handler = (ctx: Ctx) => Promise<unknown>;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body(): Promise<Buffer>;
  json<T = unknown>(): Promise<T>;
}
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:(\w+)/g, (_m, k: string) => {
      keys.push(k);
      return "([^/]+)";
    })}$`,
  );
  return { method, pattern, keys, handler };
}

function statusFor(err: EmberdeckError): number {
  switch (err.code) {
    case "UNKNOWN_STAGE":
    case "UNKNOWN_ITEM_TYPE":
    case "ITEM_NOT_FOUND":
      return 404;
    case "VALIDATION_FAILED":
    case "CONFIG_INVALID":
      return 400;
    case "CONFLICT":
      return 409;
    case "AUTH_FAILED":
      return 502;
    default:
      return 502;
  }
}

export function findDashboardDir(explicit?: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    process.env.EMBERDECK_DASHBOARD_DIR,
    join(here, "dashboard"), // bundled into dist/ for npm
    join(here, "..", "..", "dashboard", "dist"), // monorepo development
  ];
  return candidates.find((p): p is string => !!p && existsSync(join(p, "index.html")));
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const FALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>emberdeck</title>
<style>body{font:15px/1.5 system-ui;max-width:640px;margin:4rem auto;padding:0 1rem;color:#222}code{background:#f3f3f3;padding:2px 5px;border-radius:4px}</style>
<h1>🔥 emberdeck studio</h1>
<p>The API is running, but the dashboard has not been built yet.</p>
<p>Run <code>pnpm build</code> in the emberdeck repository, or set <code>EMBERDECK_DASHBOARD_DIR</code>.</p>`;

export async function startStudio(workspace: Workspace, options: StudioOptions = {}): Promise<StudioServer> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? randomBytes(24).toString("base64url");
  const tokenBuf = Buffer.from(token);
  const dashboardDir = findDashboardDir(options.dashboardDir);
  let port = options.port ?? 0;

  const stage = (ctx: Ctx) => workspace.stage(ctx.params.stage!);
  const requireParam = (ctx: Ctx, name: string): string => {
    const v = ctx.url.searchParams.get(name);
    if (!v) throw new HttpError(400, `Query parameter "${name}" is required.`);
    return v;
  };

  const routes: Route[] = [
    route("GET", "/api/meta", async () => ({
      configPath: workspace.loaded.path,
      stages: workspace.stageNames.map((name) => {
        const s = workspace.stageConfig(name);
        return {
          name,
          projectId: s.projectId,
          bucket: s.bucket ?? null,
          protected: !!s.protected,
          color: s.color ?? null,
          credentials: s.credentials.type,
        };
      }),
      itemTypes: workspace.itemTypes,
    })),

    route("GET", "/api/stages/:stage/doctor", async (ctx) => (await stage(ctx)).doctor()),

    // --- items -------------------------------------------------------------
    route("GET", "/api/stages/:stage/items/:type", async (ctx) => {
      const s = await stage(ctx);
      workspace.itemType(ctx.params.type!);
      const { etag } = await s.remoteConfig.getTemplate();
      return { etag, items: await s.listItems(ctx.params.type!) };
    }),
    route("GET", "/api/stages/:stage/items/:type/:id", async (ctx) => {
      const item = await (await stage(ctx)).getItem(ctx.params.type!, ctx.params.id!);
      if (!item) throw new HttpError(404, "Item not found.");
      return item;
    }),
    route("PUT", "/api/stages/:stage/items/:type/:id", async (ctx) => {
      const body = await ctx.json<{
        value: unknown;
        conditionalValues?: Record<string, unknown>;
        description?: string;
        etag?: string;
        validateOnly?: boolean;
      }>();
      return (await stage(ctx)).saveItem(
        ctx.params.type!,
        ctx.params.id!,
        { value: body.value, conditionalValues: body.conditionalValues, description: body.description },
        { etag: body.etag, validateOnly: body.validateOnly },
      );
    }),
    route("DELETE", "/api/stages/:stage/items/:type/:id", async (ctx) =>
      (await stage(ctx)).deleteItem(ctx.params.type!, ctx.params.id!, {
        etag: ctx.url.searchParams.get("etag") ?? undefined,
      }),
    ),

    // --- remote config (raw) -------------------------------------------------
    route("GET", "/api/stages/:stage/remote-config", async (ctx) =>
      (await stage(ctx)).remoteConfig.getTemplate(ctx.url.searchParams.get("version") ?? undefined),
    ),
    route("GET", "/api/stages/:stage/remote-config/versions", async (ctx) =>
      (await stage(ctx)).remoteConfig.listVersions(),
    ),
    route("POST", "/api/stages/:stage/remote-config/rollback", async (ctx) => {
      const { versionNumber } = await ctx.json<{ versionNumber: string }>();
      return (await stage(ctx)).remoteConfig.rollback(versionNumber);
    }),

    // --- storage -------------------------------------------------------------
    route("GET", "/api/stages/:stage/storage", async (ctx) =>
      (await stage(ctx)).requireStorage().list({
        prefix: ctx.url.searchParams.get("prefix") ?? undefined,
        delimiter: "/",
        pageToken: ctx.url.searchParams.get("pageToken") ?? undefined,
      }),
    ),
    route("GET", "/api/stages/:stage/storage/object", async (ctx) => {
      const { data, contentType } = await (await stage(ctx)).requireStorage().download(requireParam(ctx, "name"));
      ctx.res.writeHead(200, { "content-type": contentType ?? "application/octet-stream", "cache-control": "no-store" });
      ctx.res.end(data);
      return undefined;
    }),
    route("POST", "/api/stages/:stage/storage/object", async (ctx) => {
      const name = requireParam(ctx, "name");
      const metadataHeader = ctx.req.headers["x-emberdeck-metadata"];
      const metadata = typeof metadataHeader === "string" ? (JSON.parse(metadataHeader) as Record<string, string>) : undefined;
      return (await stage(ctx)).requireStorage().put(name, await ctx.body(), {
        contentType: ctx.req.headers["content-type"],
        metadata,
      });
    }),
    route("DELETE", "/api/stages/:stage/storage/object", async (ctx) => {
      await (await stage(ctx)).requireStorage().delete(requireParam(ctx, "name"));
      return { ok: true };
    }),

    // --- cross-stage -----------------------------------------------------------
    route("GET", "/api/diff", async (ctx) =>
      workspace.diff(requireParam(ctx, "from"), requireParam(ctx, "to"), requireParam(ctx, "type")),
    ),
    route("POST", "/api/promote", async (ctx) => {
      const body = await ctx.json<{ from: string; to: string; type: string; ids?: string[]; dryRun?: boolean }>();
      return workspace.promote(body);
    }),
  ];

  const allowedHosts = (): Set<string> => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  function authorize(req: IncomingMessage): void {
    if (!allowedHosts().has(req.headers.host ?? "")) throw new HttpError(403, "Invalid host.");
    const origin = req.headers.origin;
    if (origin && ![...allowedHosts()].some((h) => origin === `http://${h}`)) {
      throw new HttpError(403, "Invalid origin.");
    }
    const given = Buffer.from(String(req.headers["x-emberdeck-token"] ?? ""));
    if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) {
      throw new HttpError(401, "Missing or invalid session token. Open the URL printed by `emberdeck studio`.");
    }
  }

  async function serveStatic(url: URL, res: ServerResponse): Promise<void> {
    if (!dashboardDir) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FALLBACK_HTML);
      return;
    }
    const root = resolve(dashboardDir);
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + sep) && file !== root) throw new HttpError(403, "Forbidden.");
    const isFile = await stat(file).then((s) => s.isFile()).catch(() => false);
    if (!isFile) file = join(root, "index.html"); // SPA fallback
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(await readFile(file));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (!url.pathname.startsWith("/api/")) {
        if (!allowedHosts().has(req.headers.host ?? "")) throw new HttpError(403, "Invalid host.");
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
        await serveStatic(url, res);
        return;
      }

      authorize(req);
      const match = routes
        .filter((r) => r.method === req.method)
        .map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
        .find((x) => x.m);
      if (!match) throw new HttpError(404, "Not found.");

      const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m![i + 1]!)]));
      let bodyPromise: Promise<Buffer> | undefined;
      const body = () =>
        (bodyPromise ??= new Promise<Buffer>((resolveBody, reject) => {
          const chunks: Buffer[] = [];
          let size = 0;
          req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_UPLOAD_BYTES) {
              reject(new HttpError(413, "Payload too large."));
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          req.on("end", () => resolveBody(Buffer.concat(chunks)));
          req.on("error", reject);
        }));
      const ctx: Ctx = {
        req,
        res,
        url,
        params,
        body,
        json: async <T>() => {
          const raw = (await body()).toString("utf8");
          try {
            return (raw ? JSON.parse(raw) : {}) as T;
          } catch {
            throw new HttpError(400, "Invalid JSON body.");
          }
        },
      };

      const result = await match.r.handler(ctx);
      if (!res.headersSent) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(result ?? null));
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : isEmberdeckError(err) ? statusFor(err) : 500;
      const payload = isEmberdeckError(err)
        ? { error: err.message, code: err.code, details: err.details ?? null }
        : { error: (err as Error).message };
      if (status === 500) console.error(err);
      if (!res.headersSent) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListen());
  });
  port = (server.address() as AddressInfo).port;

  return {
    server,
    token,
    url: `http://127.0.0.1:${port}/#token=${token}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
