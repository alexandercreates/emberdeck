import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deleteItemFromTemplate,
  diffItems,
  idFromKey,
  itemsFromTemplate,
  keyForId,
  resolveItemType,
  upsertItemInTemplate,
  validateConfig,
  validateItem,
  collectStorageRefs,
  type ItemTypeConfig,
  type RemoteConfigTemplate,
} from "../src/index.js";

const banner: ItemTypeConfig = {
  target: { remoteConfig: { key: "banner_{id}", group: "marketing" } },
  fields: {
    title: { type: "string", required: true, maxLength: 20 },
    active: { type: "boolean", default: false },
    priority: { type: "number", min: 0, integer: true },
    image: { type: "storageFile", path: "banners/{id}/" },
    cta: { type: "object", fields: { url: { type: "string", pattern: "^https://" } } },
  },
};
const heroBanner: ItemTypeConfig = {
  target: { remoteConfig: { key: "banner_hero_{id}" } },
  fields: { title: { type: "string" } },
};
const flags: ItemTypeConfig = {
  target: { remoteConfig: { key: "feature_flags" } },
  fields: { newCheckout: { type: "boolean", default: false } },
};
const types = { banner, heroBanner, flags };

describe("keys", () => {
  it("maps ids to keys and back", () => {
    assert.equal(keyForId(banner, "summer"), "banner_summer");
    assert.equal(idFromKey(banner, "banner_summer"), "summer");
    assert.equal(idFromKey(banner, "other_summer"), undefined);
    assert.equal(keyForId(flags, "anything"), "feature_flags");
  });

  it("rejects invalid ids", () => {
    assert.throws(() => keyForId(banner, "no-dashes"), /Invalid item id/);
  });

  it("prefers the most specific pattern", () => {
    assert.deepEqual(resolveItemType("banner_hero_x", types), { type: "heroBanner", id: "x" });
    assert.deepEqual(resolveItemType("banner_x", types), { type: "banner", id: "x" });
    assert.deepEqual(resolveItemType("feature_flags", types), { type: "flags", id: "default" });
    assert.equal(resolveItemType("unrelated", types), undefined);
  });
});

describe("validateItem", () => {
  it("applies defaults, coerces and drops unknown keys", () => {
    const res = validateItem(banner.fields, { title: "Hi", priority: "3", unknown: 1 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.value, { title: "Hi", active: false, priority: 3 });
  });

  it("reports nested issues with paths", () => {
    const res = validateItem(banner.fields, { priority: -1.5, cta: { url: "http://x" } });
    assert.equal(res.ok, false);
    assert.deepEqual(
      res.issues.map((i) => i.path).sort(),
      ["cta.url", "priority", "priority", "title"],
    );
  });

  it("collects storage refs", () => {
    assert.deepEqual(collectStorageRefs(banner.fields, { image: "banners/a/x.png" }), ["banners/a/x.png"]);
  });
});

describe("template items", () => {
  const base: RemoteConfigTemplate = {
    conditions: [{ name: "ios", expression: "device.os == 'ios'" }],
    parameters: { untouched: { defaultValue: { value: "1" } } },
    version: { versionNumber: "7" },
  };

  it("upserts into the configured group and lists items", () => {
    const { template } = upsertItemInTemplate(base, banner, "summer", { value: { title: "Summer" } });
    assert.ok(template.parameterGroups?.marketing?.parameters.banner_summer);
    assert.equal(template.parameters?.untouched?.defaultValue && "value" in template.parameters.untouched.defaultValue, true);

    const items = itemsFromTemplate(template, "banner", types);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0]!.value, { title: "Summer", active: false });
    assert.equal(items[0]!.group, "marketing");
  });

  it("keeps conditional values on update unless replaced", () => {
    let { template } = upsertItemInTemplate(base, banner, "s", {
      value: { title: "A" },
      conditionalValues: { ios: { title: "A ios" } },
    });
    ({ template } = upsertItemInTemplate(template, banner, "s", { value: { title: "B" } }));
    const [item] = itemsFromTemplate(template, "banner", types);
    assert.deepEqual(item!.conditionalValues, { ios: { title: "A ios", active: false } });
  });

  it("rejects unknown conditions and invalid values", () => {
    assert.throws(
      () => upsertItemInTemplate(base, banner, "s", { value: { title: "x" }, conditionalValues: { android: {} } }),
      (err: Error & { details?: unknown }) => err.message.includes("invalid") && Array.isArray(err.details),
    );
    assert.throws(() => upsertItemInTemplate(base, banner, "s", { value: {} }), /invalid/);
  });

  it("flags stored values that are not JSON", () => {
    const t: RemoteConfigTemplate = { parameters: { banner_broken: { defaultValue: { value: "{nope" } } } };
    const [item] = itemsFromTemplate(t, "banner", types);
    assert.equal(item!.problems?.[0]?.message, "stored value is not valid JSON");
  });

  it("deletes items and removes empty groups", () => {
    const { template } = upsertItemInTemplate(base, banner, "s", { value: { title: "x" } });
    const next = deleteItemFromTemplate(template, banner, "s");
    assert.equal(next.parameterGroups?.marketing, undefined);
    assert.throws(() => deleteItemFromTemplate(next, banner, "s"), /does not exist/);
  });
});

describe("diffItems", () => {
  it("classifies items", () => {
    const mk = (id: string, value: Record<string, unknown>) => ({ id, key: `banner_${id}`, value });
    const diff = diffItems(
      [mk("a", { title: "1" }), mk("b", { title: "2", x: 1 }), mk("c", { x: 1, title: "3" })],
      [mk("b", { title: "2", x: 2 }), mk("c", { title: "3", x: 1 }), mk("d", {})],
    );
    assert.deepEqual(
      diff.map((d) => [d.id, d.status]),
      [["a", "added"], ["b", "changed"], ["c", "unchanged"], ["d", "removed"]],
    );
    assert.deepEqual(diff[1]!.changedFields, ["x"]);
  });
});

describe("validateConfig", () => {
  it("accepts a valid config", () => {
    const cfg = validateConfig({
      stages: { dev: { projectId: "p", credentials: { type: "adc" } } },
      items: { banner },
    });
    assert.equal(cfg.stages.dev?.projectId, "p");
  });

  it("reports all problems at once", () => {
    assert.throws(
      () =>
        validateConfig({
          stages: { dev: { credentials: { type: "serviceAccount", file: "a", env: "B" } } },
          items: {
            a: { target: { remoteConfig: { key: "x_{id}_{id}" } }, fields: { f: { type: "nope" } } },
            b: { target: { remoteConfig: { key: "has-dash" } }, fields: {} },
          },
        }),
      (err: Error & { details?: string[] }) => {
        const text = err.details!.join("\n");
        for (const fragment of ["projectId", "exactly one", "at most once", "type must be one of", "has-dash"]) {
          assert.ok(text.includes(fragment), `missing problem: ${fragment}`);
        }
        return true;
      },
    );
  });
});
