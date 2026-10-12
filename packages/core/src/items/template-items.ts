import { EmberdeckError } from "../errors.js";
import type { ItemTypeConfig } from "../config/types.js";
import {
  findParameter,
  listParameters,
  removeParameter,
  upsertParameter,
  type RemoteConfigParameter,
  type RemoteConfigParameterValue,
  type RemoteConfigTemplate,
} from "../remote-config/template.js";
import { keyForId, resolveItemType } from "./keys.js";
import { validateItem, type FieldIssue } from "./validate.js";

/**
 * Pure functions that translate between emberdeck items and a Remote Config
 * template. Every item is stored as one parameter with valueType JSON.
 */

export interface Item {
  id: string;
  key: string;
  /** Parsed default value; undefined if the parameter uses the in-app default. */
  value?: Record<string, unknown>;
  /** Parsed conditional values by condition name. */
  conditionalValues?: Record<string, Record<string, unknown>>;
  description?: string;
  group?: string;
  /** Set when the stored value is not valid JSON or doesn't match the schema. */
  problems?: FieldIssue[];
}

function parseValue(v: RemoteConfigParameterValue | undefined): { value?: Record<string, unknown>; error?: string } {
  if (!v || !("value" in v)) return {};
  try {
    const parsed = JSON.parse(v.value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "stored value is not a JSON object" };
    }
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: "stored value is not valid JSON" };
  }
}

function toItem(
  id: string,
  key: string,
  parameter: RemoteConfigParameter,
  group: string | undefined,
  type: ItemTypeConfig,
): Item {
  const problems: FieldIssue[] = [];
  const def = parseValue(parameter.defaultValue);
  if (def.error) problems.push({ path: "(default)", message: def.error });
  else if (def.value) {
    problems.push(...validateItem(type.fields, def.value).issues);
  }

  let conditionalValues: Record<string, Record<string, unknown>> | undefined;
  for (const [condition, raw] of Object.entries(parameter.conditionalValues ?? {})) {
    const parsed = parseValue(raw);
    if (parsed.error) problems.push({ path: `(${condition})`, message: parsed.error });
    if (parsed.value) {
      conditionalValues ??= {};
      conditionalValues[condition] = parsed.value;
    }
  }

  return {
    id,
    key,
    value: def.value,
    ...(conditionalValues ? { conditionalValues } : {}),
    ...(parameter.description ? { description: parameter.description } : {}),
    ...(group ? { group } : {}),
    ...(problems.length ? { problems } : {}),
  };
}

/** Lists all items of one type contained in the template, sorted by id. */
export function itemsFromTemplate(
  template: RemoteConfigTemplate,
  typeName: string,
  allTypes: Record<string, ItemTypeConfig>,
): Item[] {
  const type = allTypes[typeName];
  if (!type) throw new EmberdeckError("UNKNOWN_ITEM_TYPE", `Unknown item type "${typeName}".`);
  const items: Item[] = [];
  for (const { key, parameter, group } of listParameters(template)) {
    const match = resolveItemType(key, allTypes);
    if (match?.type !== typeName) continue;
    items.push(toItem(match.id, key, parameter, group, type));
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

export function itemFromTemplate(
  template: RemoteConfigTemplate,
  type: ItemTypeConfig,
  id: string,
): Item | undefined {
  const key = keyForId(type, id);
  const found = findParameter(template, key);
  return found ? toItem(id, key, found.parameter, found.group, type) : undefined;
}

export interface UpsertItemInput {
  value: unknown;
  /** Replace conditional values. If omitted, existing ones are kept. */
  conditionalValues?: Record<string, unknown>;
  description?: string;
}

/**
 * Validates the input and returns a new template containing the item.
 * Throws VALIDATION_FAILED with the list of issues on invalid input.
 */
export function upsertItemInTemplate(
  template: RemoteConfigTemplate,
  type: ItemTypeConfig,
  id: string,
  input: UpsertItemInput,
): { template: RemoteConfigTemplate; item: Item } {
  const key = keyForId(type, id);
  const issues: FieldIssue[] = [];

  const main = validateItem(type.fields, input.value);
  issues.push(...main.issues);

  const existing = findParameter(template, key);
  let conditionalValues = existing?.parameter.conditionalValues;
  if (input.conditionalValues) {
    conditionalValues = {};
    const known = new Set((template.conditions ?? []).map((c) => c.name));
    for (const [condition, raw] of Object.entries(input.conditionalValues)) {
      if (!known.has(condition)) {
        issues.push({ path: `(${condition})`, message: `unknown condition "${condition}"` });
        continue;
      }
      const res = validateItem(type.fields, raw);
      issues.push(...res.issues.map((i) => ({ ...i, path: `(${condition}).${i.path}` })));
      conditionalValues[condition] = { value: JSON.stringify(res.value) };
    }
  }

  if (issues.length > 0) {
    throw new EmberdeckError("VALIDATION_FAILED", `Item "${id}" is invalid.`, issues);
  }

  const parameter: RemoteConfigParameter = {
    defaultValue: { value: JSON.stringify(main.value) },
    valueType: "JSON",
    ...(conditionalValues && Object.keys(conditionalValues).length ? { conditionalValues } : {}),
  };
  const description = input.description ?? existing?.parameter.description;
  if (description) parameter.description = description;

  const next = upsertParameter(template, key, parameter, type.target.remoteConfig.group);
  return { template: next, item: itemFromTemplate(next, type, id)! };
}

export function deleteItemFromTemplate(
  template: RemoteConfigTemplate,
  type: ItemTypeConfig,
  id: string,
): RemoteConfigTemplate {
  const key = keyForId(type, id);
  if (!findParameter(template, key)) {
    throw new EmberdeckError("ITEM_NOT_FOUND", `Item "${id}" does not exist.`);
  }
  return removeParameter(template, key);
}
