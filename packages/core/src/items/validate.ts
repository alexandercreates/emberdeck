import type { FieldDef } from "../config/types.js";

export interface FieldIssue {
  /** Dotted path, e.g. `cta.url` or `slides.2.title`. */
  path: string;
  message: string;
}

export interface ValidationResult<T = Record<string, unknown>> {
  ok: boolean;
  /** Input with defaults applied and unknown keys removed. */
  value: T;
  issues: FieldIssue[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validates an item against its field definitions and applies defaults.
 * Unknown keys are dropped so stale data doesn't silently accumulate.
 */
export function validateItem(
  fields: Record<string, FieldDef>,
  input: unknown,
): ValidationResult {
  const issues: FieldIssue[] = [];
  const value = validateObject(fields, input, "", issues);
  return { ok: issues.length === 0, value, issues };
}

function validateObject(
  fields: Record<string, FieldDef>,
  input: unknown,
  path: string,
  issues: FieldIssue[],
): Record<string, unknown> {
  const source = isPlainObject(input) ? input : {};
  if (input !== undefined && !isPlainObject(input)) {
    issues.push({ path: path || "(root)", message: "must be an object" });
  }
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(fields)) {
    const childPath = path ? `${path}.${name}` : name;
    const result = validateField(def, source[name], childPath, issues);
    if (result !== undefined) out[name] = result;
  }
  return out;
}

function validateField(def: FieldDef, raw: unknown, path: string, issues: FieldIssue[]): unknown {
  let v = raw;
  if ((v === undefined || v === null || v === "") && "default" in def && def.default !== undefined) {
    v = structuredClone(def.default);
  }
  if (v === undefined || v === null || (v === "" && def.type !== "string")) {
    if (def.required) issues.push({ path, message: "is required" });
    return undefined;
  }
  if (v === "" && def.type === "string" && def.required) {
    issues.push({ path, message: "is required" });
    return v;
  }

  switch (def.type) {
    case "string": {
      if (typeof v !== "string") {
        issues.push({ path, message: "must be a string" });
        return undefined;
      }
      if (def.minLength !== undefined && v.length < def.minLength) {
        issues.push({ path, message: `must have at least ${def.minLength} characters` });
      }
      if (def.maxLength !== undefined && v.length > def.maxLength) {
        issues.push({ path, message: `must have at most ${def.maxLength} characters` });
      }
      if (def.pattern && !new RegExp(def.pattern).test(v)) {
        issues.push({ path, message: `must match ${def.pattern}` });
      }
      if (def.enum && !def.enum.includes(v)) {
        issues.push({ path, message: `must be one of ${def.enum.join(", ")}` });
      }
      return v;
    }
    case "number": {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || Number.isNaN(n)) {
        issues.push({ path, message: "must be a number" });
        return undefined;
      }
      if (def.integer && !Number.isInteger(n)) issues.push({ path, message: "must be an integer" });
      if (def.min !== undefined && n < def.min) issues.push({ path, message: `must be >= ${def.min}` });
      if (def.max !== undefined && n > def.max) issues.push({ path, message: `must be <= ${def.max}` });
      return n;
    }
    case "boolean": {
      if (v === "true" || v === "false") return v === "true";
      if (typeof v !== "boolean") {
        issues.push({ path, message: "must be true or false" });
        return undefined;
      }
      return v;
    }
    case "date": {
      if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
        issues.push({ path, message: "must be an ISO 8601 date" });
        return undefined;
      }
      return v;
    }
    case "json":
      return v;
    case "object":
      return validateObject(def.fields, v, path, issues);
    case "list": {
      if (!Array.isArray(v)) {
        issues.push({ path, message: "must be a list" });
        return undefined;
      }
      if (def.minItems !== undefined && v.length < def.minItems) {
        issues.push({ path, message: `must have at least ${def.minItems} entries` });
      }
      if (def.maxItems !== undefined && v.length > def.maxItems) {
        issues.push({ path, message: `must have at most ${def.maxItems} entries` });
      }
      return v.map((entry, i) => validateField(def.of, entry, `${path}.${i}`, issues));
    }
    case "storageFile": {
      if (typeof v !== "string") {
        issues.push({ path, message: "must be a storage object path" });
        return undefined;
      }
      return v;
    }
  }
}

/** Collects the Storage object paths referenced by an item (for promote/cleanup). */
export function collectStorageRefs(fields: Record<string, FieldDef>, value: unknown): string[] {
  const refs: string[] = [];
  const walk = (def: FieldDef, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (def.type === "storageFile" && typeof v === "string") refs.push(v);
    else if (def.type === "object" && isPlainObject(v)) {
      for (const [k, d] of Object.entries(def.fields)) walk(d, v[k]);
    } else if (def.type === "list" && Array.isArray(v)) {
      for (const entry of v) walk(def.of, entry);
    }
  };
  if (isPlainObject(value)) {
    for (const [k, d] of Object.entries(fields)) walk(d, value[k]);
  }
  return refs;
}
