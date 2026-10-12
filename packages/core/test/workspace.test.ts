import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Workspace, validateConfig, type EmberdeckError } from "../src/index.js";
import { FakeGoogle } from "./fake-google.js";

const google = new FakeGoogle();

function workspace(): Workspace {
  const config = validateConfig({
    stages: {
      dev: { projectId: "app-dev", bucket: "dev-bucket", credentials: { type: "serviceAccount", env: "ED_TEST_SA" } },
      prod: { projectId: "app-prod", bucket: "prod-bucket", credentials: { type: "serviceAccount", env: "ED_TEST_SA" } },
    },
    items: {
      banner: {
        target: { remoteConfig: { key: "banner_{id}" } },
        fields: {
          title: { type: "string", required: true },
          image: { type: "storageFile", path: "banners/{id}/" },
        },
      },
    },
  });
  return new Workspace({ config, path: "/virtual/emberdeck.config.json", rootDir: "/virtual" });
}

describe("Workspace against fake Google APIs", () => {
  before(() => {
    process.env.ED_TEST_SA = google.serviceAccountJson();
    google.install();
  });
  after(() => google.uninstall());
  beforeEach(() => {
    google.projects.clear();
    google.buckets.clear();
  });

  it("saves, lists and deletes items", async () => {
    const dev = await workspace().stage("dev");
    await dev.saveItem("banner", "summer", { value: { title: "Summer" } });
    await dev.saveItem("banner", "winter", { value: { title: "Winter" } });

    const items = await dev.listItems("banner");
    assert.deepEqual(items.map((i) => i.id), ["summer", "winter"]);

    await dev.deleteItem("banner", "summer");
    assert.deepEqual((await dev.listItems("banner")).map((i) => i.id), ["winter"]);
  });

  it("detects concurrent edits via etag", async () => {
    const dev = await workspace().stage("dev");
    const { etag } = await dev.remoteConfig.getTemplate();
    await dev.saveItem("banner", "a", { value: { title: "first" } });
    await assert.rejects(
      dev.saveItem("banner", "a", { value: { title: "second" } }, { etag }),
      (err: EmberdeckError) => err.code === "CONFLICT",
    );
  });

  it("diffs and promotes items including storage files", async () => {
    const ws = workspace();
    const dev = await ws.stage("dev");
    await dev.requireStorage().put("banners/summer/hero.png", Buffer.from([0, 1, 2, 255]), {
      contentType: "image/png",
      metadata: { alt: "beach" },
    });
    await dev.saveItem("banner", "summer", { value: { title: "Summer", image: "banners/summer/hero.png" } });

    const diff = await ws.diff("dev", "prod", "banner");
    assert.deepEqual(diff.map((d) => [d.id, d.status]), [["summer", "added"]]);

    const dry = await ws.promote({ from: "dev", to: "prod", type: "banner", dryRun: true });
    assert.equal(dry.items[0]?.action, "created");
    assert.equal(google.buckets.get("prod-bucket")?.size ?? 0, 0, "dry run must not copy files");

    const report = await ws.promote({ from: "dev", to: "prod", type: "banner", ids: ["summer"] });
    assert.deepEqual(report.files, [{ path: "banners/summer/hero.png", action: "created" }]);
    const copied = google.buckets.get("prod-bucket")?.get("banners/summer/hero.png");
    assert.deepEqual([...copied!.data], [0, 1, 2, 255]);
    assert.deepEqual(copied!.metadata, { alt: "beach" });

    const after = await ws.diff("dev", "prod", "banner");
    assert.equal(after[0]?.status, "unchanged");

    const again = await ws.promote({ from: "dev", to: "prod", type: "banner" });
    assert.deepEqual(again.files, [{ path: "banners/summer/hero.png", action: "unchanged" }]);
  });

  it("doctor reports all checks", async () => {
    const checks = await (await workspace().stage("dev")).doctor();
    assert.deepEqual(checks.map((c) => [c.name, c.ok]), [
      ["credentials", true],
      ["remote config (read)", true],
      ["remote config (validate publish)", true],
      ["storage (list)", true],
    ]);
  });
});
