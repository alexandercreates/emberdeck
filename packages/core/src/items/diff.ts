import type { Item } from "./template-items.js";

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface ItemDiff {
  id: string;
  /** Relative to the target: `added` = exists only in the source stage. */
  status: DiffStatus;
  source?: Item;
  target?: Item;
  /** Top-level fields whose default value differs. */
  changedFields?: string[];
  conditionalValuesDiffer?: boolean;
}

/** JSON with sorted keys, so `{a,b}` and `{b,a}` compare equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export function diffItems(source: Item[], target: Item[]): ItemDiff[] {
  const src = new Map(source.map((i) => [i.id, i]));
  const tgt = new Map(target.map((i) => [i.id, i]));
  const ids = [...new Set([...src.keys(), ...tgt.keys()])].sort((a, b) => a.localeCompare(b));

  return ids.map((id): ItemDiff => {
    const s = src.get(id);
    const t = tgt.get(id);
    if (s && !t) return { id, status: "added", source: s };
    if (!s && t) return { id, status: "removed", target: t };

    const a = s!.value ?? {};
    const b = t!.value ?? {};
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const changedFields = fields.filter((f) => canonicalJson(a[f]) !== canonicalJson(b[f])).sort();
    const conditionalValuesDiffer =
      canonicalJson(s!.conditionalValues ?? {}) !== canonicalJson(t!.conditionalValues ?? {});

    const changed = changedFields.length > 0 || conditionalValuesDiffer;
    return {
      id,
      status: changed ? "changed" : "unchanged",
      source: s,
      target: t,
      ...(changedFields.length ? { changedFields } : {}),
      ...(conditionalValuesDiffer ? { conditionalValuesDiffer } : {}),
    };
  });
}
