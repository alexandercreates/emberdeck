import { createTokenProvider, type TokenProvider } from "./auth/google.js";
import { loadConfig, type LoadedConfig } from "./config/load.js";
import type { EmberdeckConfig, ItemTypeConfig, StageConfig } from "./config/types.js";
import { EmberdeckError } from "./errors.js";
import { diffItems, type ItemDiff } from "./items/diff.js";
import { isCollection } from "./items/keys.js";
import {
  deleteItemFromTemplate,
  itemFromTemplate,
  itemsFromTemplate,
  upsertItemInTemplate,
  type Item,
  type UpsertItemInput,
} from "./items/template-items.js";
import { collectStorageRefs } from "./items/validate.js";
import { RemoteConfigClient } from "./remote-config/client.js";
import { StorageClient } from "./storage/client.js";

/**
 * Entry point for programmatic use. Wraps a loaded config and lazily creates
 * authenticated clients per stage.
 *
 * ```ts
 * const ed = await Workspace.load();
 * const dev = await ed.stage("dev");
 * await dev.saveItem("banner", "summer", { value: { title: "Hi" } });
 * ```
 */
export class Workspace {
  private readonly stages = new Map<string, Promise<Stage>>();

  constructor(readonly loaded: LoadedConfig) {}

  static async load(configPath?: string): Promise<Workspace> {
    return new Workspace(await loadConfig(configPath));
  }

  get config(): EmberdeckConfig {
    return this.loaded.config;
  }

  get stageNames(): string[] {
    return Object.keys(this.config.stages);
  }

  get itemTypes(): Record<string, ItemTypeConfig> {
    return this.config.items ?? {};
  }

  itemType(name: string): ItemTypeConfig {
    const type = this.itemTypes[name];
    if (!type) {
      throw new EmberdeckError(
        "UNKNOWN_ITEM_TYPE",
        `Unknown item type "${name}". Known: ${Object.keys(this.itemTypes).join(", ") || "(none)"}`,
      );
    }
    return type;
  }

  stageConfig(name: string): StageConfig {
    const stage = this.config.stages[name];
    if (!stage) {
      throw new EmberdeckError("UNKNOWN_STAGE", `Unknown stage "${name}". Known: ${this.stageNames.join(", ")}`);
    }
    return stage;
  }

  stage(name: string): Promise<Stage> {
    let pending = this.stages.get(name);
    if (!pending) {
      const config = this.stageConfig(name);
      pending = createTokenProvider(config.credentials, { rootDir: this.loaded.rootDir }).then(
        (auth) => new Stage(name, config, auth, this.itemTypes),
      );
      // Don't cache failures, so fixing credentials doesn't require a restart.
      pending.catch(() => this.stages.delete(name));
      this.stages.set(name, pending);
    }
    return pending;
  }

  async diff(from: string, to: string, type: string): Promise<ItemDiff[]> {
    this.itemType(type);
    const [a, b] = await Promise.all([this.stage(from), this.stage(to)]);
    const [sa, sb] = await Promise.all([a.listItems(type), b.listItems(type)]);
    return diffItems(sa, sb);
  }

  /**
   * Copies items (and the Storage files they reference) from one stage to
   * another in a single Remote Config publish.
   *
   * Only default values are promoted. Conditional values stay as they are in
   * the target, because condition names usually differ between projects.
   */
  async promote(options: PromoteOptions): Promise<PromoteReport> {
    const { from, to, type: typeName, dryRun = false } = options;
    if (from === to) throw new EmberdeckError("VALIDATION_FAILED", "Source and target stage are the same.");
    const type = this.itemType(typeName);
    const [source, target] = await Promise.all([this.stage(from), this.stage(to)]);

    const [sourceItems, { template, etag }] = await Promise.all([
      source.listItems(typeName),
      target.remoteConfig.getTemplate(),
    ]);
    const wanted = options.ids ? new Set(options.ids) : undefined;
    const selected = sourceItems.filter((i) => !wanted || wanted.has(i.id));
    if (wanted) {
      const missing = [...wanted].filter((id) => !selected.some((i) => i.id === id));
      if (missing.length) {
        throw new EmberdeckError("ITEM_NOT_FOUND", `Not found in ${from}: ${missing.join(", ")}`);
      }
    }

    let next = template;
    const report: PromoteReport = { from, to, type: typeName, items: [], files: [], dryRun };
    for (const item of selected) {
      if (!item.value) {
        report.items.push({ id: item.id, action: "skipped", reason: "uses in-app default" });
        continue;
      }
      const before = itemFromTemplate(next, type, item.id);
      const res = upsertItemInTemplate(next, type, item.id, {
        value: item.value,
        description: item.description,
      });
      next = res.template;
      report.items.push({ id: item.id, action: before ? "updated" : "created" });

      for (const path of collectStorageRefs(type.fields, item.value)) {
        report.files.push({ path, action: await this.copyFile(source, target, path, dryRun) });
      }
    }

    if (!dryRun && report.items.some((i) => i.action !== "skipped")) {
      await target.remoteConfig.publish(next, {
        etag,
        description: options.description ?? `emberdeck: promote ${typeName} from ${from}`,
      });
    }
    return report;
  }

  private async copyFile(source: Stage, target: Stage, path: string, dryRun: boolean): Promise<FileAction> {
    const src = source.requireStorage();
    const dst = target.requireStorage();
    const [a, b] = await Promise.all([src.stat(path), dst.stat(path)]);
    if (!a) return "missing-in-source";
    if (b && a.md5Hash && a.md5Hash === b.md5Hash) return "unchanged";
    if (!dryRun) {
      const { data, contentType } = await src.download(path);
      await dst.put(path, data, { contentType: a.contentType ?? contentType, metadata: a.metadata });
    }
    return b ? "updated" : "created";
  }
}

export interface PromoteOptions {
  from: string;
  to: string;
  type: string;
  /** Limit to these item ids; all items of the type otherwise. */
  ids?: string[];
  dryRun?: boolean;
  description?: string;
}

export type FileAction = "created" | "updated" | "unchanged" | "missing-in-source";

export interface PromoteReport {
  from: string;
  to: string;
  type: string;
  dryRun: boolean;
  items: { id: string; action: "created" | "updated" | "skipped"; reason?: string }[];
  files: { path: string; action: FileAction }[];
}

export class Stage {
  readonly remoteConfig: RemoteConfigClient;
  readonly storage?: StorageClient;

  constructor(
    readonly name: string,
    readonly config: StageConfig,
    readonly auth: TokenProvider,
    private readonly itemTypes: Record<string, ItemTypeConfig>,
  ) {
    this.remoteConfig = new RemoteConfigClient(auth, config.projectId);
    if (config.bucket) this.storage = new StorageClient(auth, config.bucket);
  }

  requireStorage(): StorageClient {
    if (!this.storage) {
      throw new EmberdeckError("CONFIG_INVALID", `Stage "${this.name}" has no \`bucket\` configured.`);
    }
    return this.storage;
  }

  private type(name: string): ItemTypeConfig {
    const type = this.itemTypes[name];
    if (!type) throw new EmberdeckError("UNKNOWN_ITEM_TYPE", `Unknown item type "${name}".`);
    return type;
  }

  async listItems(typeName: string): Promise<Item[]> {
    const { template } = await this.remoteConfig.getTemplate();
    return itemsFromTemplate(template, typeName, this.itemTypes);
  }

  async getItem(typeName: string, id: string): Promise<Item | undefined> {
    const { template } = await this.remoteConfig.getTemplate();
    return itemFromTemplate(template, this.type(typeName), id);
  }

  /**
   * Creates or updates an item. Pass `etag` from a previous read to make the
   * write fail with CONFLICT if someone else published in the meantime.
   */
  async saveItem(
    typeName: string,
    id: string,
    input: UpsertItemInput,
    options: { etag?: string; validateOnly?: boolean; description?: string } = {},
  ): Promise<{ item: Item; etag: string }> {
    const type = this.type(typeName);
    const current = await this.remoteConfig.getTemplate();
    if (options.etag && options.etag !== current.etag) {
      throw new EmberdeckError("CONFLICT", "Remote Config changed since you loaded it. Reload and try again.");
    }
    const { template, item } = upsertItemInTemplate(current.template, type, id, input);
    const res = await this.remoteConfig.publish(template, {
      etag: current.etag,
      validateOnly: options.validateOnly,
      description: options.description ?? `emberdeck: save ${typeName}/${id}`,
    });
    return { item, etag: res.etag };
  }

  async deleteItem(
    typeName: string,
    id: string,
    options: { etag?: string; description?: string } = {},
  ): Promise<{ etag: string }> {
    const type = this.type(typeName);
    if (!isCollection(type)) {
      throw new EmberdeckError("VALIDATION_FAILED", `"${typeName}" is a singleton and cannot be deleted.`);
    }
    const current = await this.remoteConfig.getTemplate();
    if (options.etag && options.etag !== current.etag) {
      throw new EmberdeckError("CONFLICT", "Remote Config changed since you loaded it. Reload and try again.");
    }
    const template = deleteItemFromTemplate(current.template, type, id);
    const res = await this.remoteConfig.publish(template, {
      etag: current.etag,
      description: options.description ?? `emberdeck: delete ${typeName}/${id}`,
    });
    return { etag: res.etag };
  }

  /** Verifies credentials and permissions; never throws. */
  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const run = async (name: string, fn: () => Promise<string>): Promise<void> => {
      try {
        checks.push({ name, ok: true, detail: await fn() });
      } catch (err) {
        checks.push({ name, ok: false, detail: (err as Error).message });
      }
    };
    await run("credentials", async () => {
      await this.auth.getAccessToken();
      return await this.auth.describe();
    });
    if (!checks[0]!.ok) return checks;
    await run("remote config (read)", async () => {
      const { template } = await this.remoteConfig.getTemplate();
      return `version ${template.version?.versionNumber ?? "?"}, ${Object.keys(template.parameters ?? {}).length} top-level parameters`;
    });
    await run("remote config (validate publish)", async () => {
      const { template, etag } = await this.remoteConfig.getTemplate();
      await this.remoteConfig.publish(template, { etag, validateOnly: true });
      return "write access ok";
    });
    if (this.storage) {
      const storage = this.storage;
      await run("storage (list)", async () => {
        const res = await storage.list({ maxResults: 1 });
        return `bucket ${storage.bucket} reachable (${res.objects.length ? "has objects" : "empty"})`;
      });
    } else {
      checks.push({ name: "storage", ok: true, detail: "no bucket configured (skipped)" });
    }
    return checks;
  }
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
