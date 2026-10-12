import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import type { RemoteConfigTemplate } from "../src/index.js";

/**
 * In-memory fake of the Google OAuth, Remote Config and Cloud Storage
 * endpoints emberdeck talks to. Installs itself as global fetch.
 */
export class FakeGoogle {
  readonly projects = new Map<string, { template: RemoteConfigTemplate; version: number }>();
  readonly buckets = new Map<string, Map<string, { data: Buffer; contentType: string; metadata?: Record<string, string> }>>();
  readonly requests: string[] = [];
  private readonly realFetch = globalThis.fetch;
  readonly keys = generateKeyPairSync("rsa", { modulusLength: 2048 });

  serviceAccountJson(email = "sa@test.iam.gserviceaccount.com"): string {
    return JSON.stringify({
      type: "service_account",
      client_email: email,
      private_key: this.keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      token_uri: "https://oauth2.googleapis.com/token",
    });
  }

  install(): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      this.handle(new URL(String(input)), init ?? {})) as typeof fetch;
  }

  uninstall(): void {
    globalThis.fetch = this.realFetch;
  }

  etag(projectId: string): string {
    return `etag-${this.projects.get(projectId)?.version ?? 0}`;
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private async handle(url: URL, init: RequestInit): Promise<Response> {
    const method = init.method ?? "GET";
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    const headers = new Headers(init.headers);

    if (url.hostname === "oauth2.googleapis.com") {
      const body = new URLSearchParams(String(init.body));
      const [h, c, s] = (body.get("assertion") ?? "").split(".");
      const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(this.keys.publicKey, Buffer.from(s ?? "", "base64url"));
      if (!ok) return this.json({ error: "invalid_grant" }, 400);
      return this.json({ access_token: "token-123", expires_in: 3600 });
    }

    if (headers.get("authorization") !== "Bearer token-123") return this.json({ error: { message: "unauthenticated" } }, 401);

    if (url.hostname === "firebaseremoteconfig.googleapis.com") {
      const projectId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const project = this.projects.get(projectId) ?? { template: {}, version: 1 };
      this.projects.set(projectId, project);
      if (method === "GET") {
        return this.json(
          { ...project.template, version: { versionNumber: String(project.version) } },
          200,
          { etag: this.etag(projectId) },
        );
      }
      if (method === "PUT") {
        if (headers.get("if-match") !== "*" && headers.get("if-match") !== this.etag(projectId)) {
          return this.json({ error: { message: "etag mismatch" } }, 412);
        }
        const template = JSON.parse(String(init.body)) as RemoteConfigTemplate;
        if (url.searchParams.get("validateOnly") === "true") return this.json(template, 200, { etag: this.etag(projectId) });
        delete template.version;
        project.template = template;
        project.version += 1;
        return this.json(template, 200, { etag: this.etag(projectId) });
      }
    }

    if (url.hostname === "storage.googleapis.com") {
      const parts = url.pathname.split("/");
      const isUpload = parts[1] === "upload";
      const bucketName = decodeURIComponent(parts[isUpload ? 5 : 4] ?? "");
      const bucket = this.buckets.get(bucketName) ?? new Map();
      this.buckets.set(bucketName, bucket);
      const objectName = parts[isUpload ? 7 : 6] ? decodeURIComponent(parts[isUpload ? 7 : 6]!) : undefined;
      const describe = (name: string) => {
        const o = bucket.get(name)!;
        return {
          name,
          bucket: bucketName,
          size: String(o.data.length),
          contentType: o.contentType,
          md5Hash: createHash("md5").update(o.data).digest("base64"),
          metadata: o.metadata,
        };
      };

      if (isUpload && method === "POST") {
        const raw = Buffer.from(init.body as Uint8Array);
        const boundary = /boundary=(.+)$/.exec(headers.get("content-type") ?? "")![1]!;
        const sections = raw.toString("latin1").split(`--${boundary}`);
        const meta = JSON.parse(sections[1]!.split("\r\n\r\n")[1]!.trim()) as {
          name: string;
          contentType: string;
          metadata?: Record<string, string>;
        };
        const payload = sections[2]!.slice(sections[2]!.indexOf("\r\n\r\n") + 4, -2);
        bucket.set(meta.name, { data: Buffer.from(payload, "latin1"), contentType: meta.contentType, metadata: meta.metadata });
        return this.json(describe(meta.name));
      }
      if (!objectName) {
        const prefix = url.searchParams.get("prefix") ?? "";
        const delimiter = url.searchParams.get("delimiter");
        const names = [...bucket.keys()].filter((k) => k.startsWith(prefix)).sort();
        if (!delimiter) return this.json({ items: names.map(describe) });
        const prefixes = new Set<string>();
        const items: string[] = [];
        for (const name of names) {
          const rest = name.slice(prefix.length);
          const i = rest.indexOf(delimiter);
          if (i === -1) items.push(name);
          else prefixes.add(prefix + rest.slice(0, i + delimiter.length));
        }
        return this.json({ items: items.map(describe), prefixes: [...prefixes] });
      }
      if (!bucket.has(objectName)) return this.json({ error: { message: "not found" } }, 404);
      if (method === "DELETE") {
        bucket.delete(objectName);
        return new Response(null, { status: 204 });
      }
      if (url.searchParams.get("alt") === "media") {
        const o = bucket.get(objectName)!;
        return new Response(o.data, { headers: { "content-type": o.contentType } });
      }
      return this.json(describe(objectName));
    }

    return this.json({ error: { message: `unhandled ${method} ${url}` } }, 500);
  }
}
