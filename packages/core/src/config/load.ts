import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EmberdeckError } from "../errors.js";
import type { EmberdeckConfig, FieldDef } from "./types.js";

export const CONFIG_FILE_NAMES = [
  "emberdeck.config.ts",
  "emberdeck.config.mts",
  "emberdeck.config.mjs",
  "emberdeck.config.js",
  "emberdeck.config.json",
] as const;

export interface LoadedConfig {
  config: EmberdeckConfig;
  /** Absolute path of the config file. */
  path: string;
  /** Directory of the config file; relative paths in the config resolve against it. */
  rootDir: string;
}

/** Walks up from `startDir` until it finds an emberdeck config file. */
export function findConfigFile(startDir: string = process.cwd()): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const path = explicitPath ? resolve(explicitPath) : findConfigFile();
  if (!path || !existsSync(path)) {
    throw new EmberdeckError(
      "CONFIG_NOT_FOUND",
      explicitPath
        ? `Config file not found: ${explicitPath}`
        : `No emberdeck config found. Run \`emberdeck init\` to create one.`,
    );
  }

  let raw: unknown;
  if (path.endsWith(".json")) {
    raw = JSON.parse(await readFile(path, "utf8"));
  } else {
    try {
      const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
      raw = mod.default ?? mod;
    } catch (err) {
      const hint = /\.m?ts$/.test(path)
        ? " TypeScript configs need Node.js >= 22.18 (native type stripping) or the emberdeck binary."
        : "";
      throw new EmberdeckError(
        "CONFIG_INVALID",
        `Could not load ${path}: ${(err as Error).message}.${hint}`,
      );
    }
  }

  const config = validateConfig(raw);
  return { config, path, rootDir: dirname(path) };
}

// ---------------------------------------------------------------------------
// Validation (intentionally dependency free)
// ---------------------------------------------------------------------------

const FIELD_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "date",
  "json",
  "object",
  "list",
  "storageFile",
]);

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RC_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateConfig(raw: unknown): EmberdeckConfig {
  const problems: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  if (!isObj(raw)) {
    throw new EmberdeckError("CONFIG_INVALID", "Config must export an object.");
  }

  // stages
  if (!isObj(raw.stages) || Object.keys(raw.stages).length === 0) {
    problems.push("`stages` must define at least one stage.");
  } else {
    for (const [name, stage] of Object.entries(raw.stages)) {
      const at = `stages.${name}`;
      if (!NAME_RE.test(name)) problems.push(`${at}: invalid stage name.`);
      if (!isObj(stage)) {
        problems.push(`${at} must be an object.`);
        continue;
      }
      if (typeof stage.projectId !== "string" || !stage.projectId) {
        problems.push(`${at}.projectId is required.`);
      }
      if (stage.bucket !== undefined && typeof stage.bucket !== "string") {
        problems.push(`${at}.bucket must be a string.`);
      }
      const creds = stage.credentials;
      if (!isObj(creds)) {
        problems.push(`${at}.credentials is required.`);
      } else if (creds.type === "serviceAccount") {
        const hasFile = typeof creds.file === "string";
        const hasEnv = typeof creds.env === "string";
        if (hasFile === hasEnv) {
          problems.push(`${at}.credentials: serviceAccount needs exactly one of \`file\` or \`env\`.`);
        }
      } else if (creds.type === "adc") {
        if (creds.impersonate !== undefined && typeof creds.impersonate !== "string") {
          problems.push(`${at}.credentials.impersonate must be a service account email.`);
        }
      } else {
        problems.push(`${at}.credentials.type must be "serviceAccount" or "adc".`);
      }
    }
  }

  // items
  if (raw.items !== undefined) {
    if (!isObj(raw.items)) {
      problems.push("`items` must be an object.");
    } else {
      const usedKeys = new Map<string, string>();
      for (const [name, item] of Object.entries(raw.items)) {
        const at = `items.${name}`;
        if (!NAME_RE.test(name)) problems.push(`${at}: invalid item type name.`);
        if (!isObj(item)) {
          problems.push(`${at} must be an object.`);
          continue;
        }
        const rc = isObj(item.target) && isObj(item.target.remoteConfig) ? item.target.remoteConfig : undefined;
        if (!rc || typeof rc.key !== "string") {
          problems.push(`${at}.target.remoteConfig.key is required.`);
        } else {
          const key = rc.key;
          const placeholders = key.match(/\{id\}/g)?.length ?? 0;
          if (placeholders > 1) problems.push(`${at}: key may contain \`{id}\` at most once.`);
          if (!RC_KEY_RE.test(key.replace("{id}", "x"))) {
            problems.push(`${at}: key "${key}" is not a valid Remote Config key.`);
          }
          const other = usedKeys.get(key);
          if (other) problems.push(`${at}: key "${key}" is already used by items.${other}.`);
          usedKeys.set(key, name);
        }
        if (!isObj(item.fields)) {
          problems.push(`${at}.fields is required.`);
        } else {
          validateFields(item.fields, `${at}.fields`, problems);
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new EmberdeckError(
      "CONFIG_INVALID",
      `Invalid emberdeck config:\n  - ${problems.join("\n  - ")}`,
      problems,
    );
  }
  return raw as unknown as EmberdeckConfig;
}

function validateFields(fields: Record<string, unknown>, at: string, problems: string[]): void {
  for (const [name, field] of Object.entries(fields)) {
    validateField(field, `${at}.${name}`, problems);
  }
}

function validateField(field: unknown, at: string, problems: string[]): void {
  if (typeof field !== "object" || field === null) {
    problems.push(`${at} must be an object.`);
    return;
  }
  const f = field as Partial<FieldDef> & Record<string, unknown>;
  if (typeof f.type !== "string" || !FIELD_TYPES.has(f.type)) {
    problems.push(`${at}.type must be one of ${[...FIELD_TYPES].join(", ")}.`);
    return;
  }
  if (f.type === "object") {
    if (typeof f.fields !== "object" || f.fields === null) problems.push(`${at}.fields is required.`);
    else validateFields(f.fields as Record<string, unknown>, `${at}.fields`, problems);
  }
  if (f.type === "list") {
    if (f.of === undefined) problems.push(`${at}.of is required.`);
    else validateField(f.of, `${at}.of`, problems);
  }
  if (f.type === "storageFile" && typeof f.path !== "string") {
    problems.push(`${at}.path is required.`);
  }
  if (f.type === "string" && typeof f.pattern === "string") {
    try {
      new RegExp(f.pattern);
    } catch {
      problems.push(`${at}.pattern is not a valid regular expression.`);
    }
  }
}
