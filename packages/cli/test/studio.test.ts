import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Workspace, validateConfig } from "@emberdeck/core";
import { FakeGoogle } from "../../core/test/fake-google.js";
import { startStudio, type StudioServer } from "../src/server.js";

const google = new FakeGoogle();
let studio: StudioServer;
let base: string;

// The fake replaces global fetch, so talk to the local server through the real one.
const realFetch = globalThis.fetch;

async function api(path: string, init: RequestInit & { token?: string | null } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set("x-emberdeck-token", init.token ?? studio.token);
  return realFetch(`${base}${path}`, { ...init, headers });
}

describe("studio server", () => {
  before(async () => {
    process.env.ED_TEST_SA = google.serviceAccountJson();
    const config = validateConfig({
      stages: {
        dev: { projectId: "app-dev", bucket: "dev-bucket", credentials: { type: "serviceAccount", env: "ED_TEST_SA" } },
      },
      items: {
        banner: { target: { remoteConfig: { key: "banner_{id}" } }, fields: { title: { type: "string", required: true } } },
      },
    });
    const ws = new Workspace({ config, path: "/virtual/emberdeck.config.json", rootDir: "/virtual" });
    studio = await startStudio(ws, { dashboardDir: "/nonexistent" });
    base = new URL(studio.url).origin;
    google.install();
  });
  after(async () => {
    google.uninstall();
    await studio.close();
  });

  it("rejects requests without token", async () => {
    const res = await api("/api/meta", { token: null });
    assert.equal(res.status, 401);
  });

  it("rejects foreign origins", async () => {
    const res = await api("/api/meta", { headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
  });

  it("serves meta", async () => {
    const meta = (await (await api("/api/meta")).json()) as { stages: { name: string }[]; itemTypes: object };
    assert.deepEqual(meta.stages.map((s) => s.name), ["dev"]);
    assert.ok("banner" in meta.itemTypes);
  });

  it("creates, lists and deletes items", async () => {
    const put = await api("/api/stages/dev/items/banner/summer", {
      method: "PUT",
      body: JSON.stringify({ value: { title: "Summer" } }),
    });
    assert.equal(put.status, 200);

    const list = (await (await api("/api/stages/dev/items/banner")).json()) as { etag: string; items: { id: string }[] };
    assert.deepEqual(list.items.map((i) => i.id), ["summer"]);

    const del = await api(`/api/stages/dev/items/banner/summer?etag=${encodeURIComponent(list.etag)}`, { method: "DELETE" });
    assert.equal(del.status, 200);
  });

  it("returns validation details with 400", async () => {
    const res = await api("/api/stages/dev/items/banner/x", { method: "PUT", body: JSON.stringify({ value: {} }) });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; details: { path: string }[] };
    assert.equal(body.code, "VALIDATION_FAILED");
    assert.equal(body.details[0]?.path, "title");
  });

  it("uploads and downloads storage objects", async () => {
    const up = await api("/api/stages/dev/storage/object?name=a%2Fb.txt", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    assert.equal(up.status, 200);
    const down = await api("/api/stages/dev/storage/object?name=a%2Fb.txt");
    assert.equal(await down.text(), "hello");
  });

  it("serves the fallback page when the dashboard is not built", async () => {
    const res = await realFetch(`${base}/`);
    assert.match(await res.text(), /emberdeck studio/);
  });
});

describe("embedded dashboard assets", () => {
  it("serves embedded files with SPA fallback", async () => {
    const { embeddedAssets } = await import("../src/dashboard-assets.js");
    const ws = new Workspace({
      config: validateConfig({ stages: { dev: { projectId: "p", credentials: { type: "adc" } } } }),
      path: "/virtual/emberdeck.config.json",
      rootDir: "/virtual",
    });
    const server = await startStudio(ws, {
      dashboard: embeddedAssets({
        "index.html": Buffer.from("<h1>embedded</h1>").toString("base64"),
        "assets/app.js": Buffer.from("console.log(1)").toString("base64"),
      }),
    });
    try {
      const origin = new URL(server.url).origin;
      const js = await realFetch(`${origin}/assets/app.js`);
      assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
      assert.equal(await js.text(), "console.log(1)");
      assert.equal(await (await realFetch(`${origin}/some/route`)).text(), "<h1>embedded</h1>");
      assert.equal(await (await realFetch(`${origin}/../../etc/passwd`)).text(), "<h1>embedded</h1>");
    } finally {
      await server.close();
    }
  });
});
