import { EmberdeckError } from "../errors.js";
import type { ItemTypeConfig } from "../config/types.js";

/** Item ids end up inside Remote Config keys, so they share the same alphabet. */
export const ITEM_ID_RE = /^[A-Za-z0-9_]+$/;

export function isCollection(type: ItemTypeConfig): boolean {
  return type.target.remoteConfig.key.includes("{id}");
}

/** Id used for singleton item types. */
export const SINGLETON_ID = "default";

export function keyForId(type: ItemTypeConfig, id: string): string {
  const pattern = type.target.remoteConfig.key;
  if (!isCollection(type)) return pattern;
  if (!ITEM_ID_RE.test(id)) {
    throw new EmberdeckError(
      "VALIDATION_FAILED",
      `Invalid item id "${id}". Use letters, digits and underscores only.`,
    );
  }
  return pattern.replace("{id}", id);
}

function patternParts(pattern: string): { prefix: string; suffix: string } {
  const i = pattern.indexOf("{id}");
  return i === -1 ? { prefix: pattern, suffix: "" } : { prefix: pattern.slice(0, i), suffix: pattern.slice(i + 4) };
}

/** Returns the item id if `key` matches the type's key pattern. */
export function idFromKey(type: ItemTypeConfig, key: string): string | undefined {
  const pattern = type.target.remoteConfig.key;
  if (!isCollection(type)) return key === pattern ? SINGLETON_ID : undefined;
  const { prefix, suffix } = patternParts(pattern);
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return undefined;
  const id = key.slice(prefix.length, key.length - suffix.length);
  return id.length > 0 && ITEM_ID_RE.test(id) ? id : undefined;
}

/**
 * Finds the item type a Remote Config key belongs to. When several patterns
 * match (e.g. `banner_{id}` and `banner_hero_{id}`) the most specific one —
 * the one with the most literal characters — wins.
 */
export function resolveItemType(
  key: string,
  types: Record<string, ItemTypeConfig>,
): { type: string; id: string } | undefined {
  let best: { type: string; id: string; score: number } | undefined;
  for (const [name, type] of Object.entries(types)) {
    const id = idFromKey(type, key);
    if (id === undefined) continue;
    const score = isCollection(type) ? type.target.remoteConfig.key.length - 4 : Number.MAX_SAFE_INTEGER;
    if (!best || score > best.score) best = { type: name, id, score };
  }
  return best ? { type: best.type, id: best.id } : undefined;
}
