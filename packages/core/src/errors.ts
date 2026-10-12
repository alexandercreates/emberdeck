export type ErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "UNKNOWN_STAGE"
  | "UNKNOWN_ITEM_TYPE"
  | "ITEM_NOT_FOUND"
  | "VALIDATION_FAILED"
  | "AUTH_FAILED"
  | "API_ERROR"
  | "CONFLICT";

export class EmberdeckError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "EmberdeckError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Duck-typed on purpose: with duplicated package copies (e.g. a global CLI and
 * a local install) `instanceof` would fail across module instances.
 */
export function isEmberdeckError(err: unknown): err is EmberdeckError {
  if (err instanceof EmberdeckError) return true;
  const e = err as { name?: unknown; code?: unknown } | null;
  return typeof e === "object" && e !== null && e.name === "EmberdeckError" && typeof e.code === "string";
}
