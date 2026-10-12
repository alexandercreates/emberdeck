import type { DoctorCheck, Item, ItemDiff, ItemTypeConfig, ListResult, PromoteReport } from "@emberdeck/core";

const TOKEN_KEY = "emberdeck.token";

/** Reads the session token from `#token=…` once, then keeps it in sessionStorage. */
function readToken(): string | null {
  const match = /token=([^&]+)/.exec(window.location.hash);
  if (match?.[1]) {
    try {
      sessionStorage.setItem(TOKEN_KEY, match[1]);
    } catch {
      // storage unavailable — keep token in memory only
    }
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return match[1];
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const token = readToken();

export const hasToken = (): boolean => !!token;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("x-emberdeck-token", token);
  if (init.body && typeof init.body === "string") headers.set("content-type", "application/json");
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; details?: unknown };
    throw new ApiError(res.status, body.error ?? res.statusText, body.code, body.details);
  }
  return (await res.json()) as T;
}

export interface StageInfo {
  name: string;
  projectId: string;
  bucket: string | null;
  protected: boolean;
  color: string | null;
  credentials: string;
}

export interface Meta {
  configPath: string;
  stages: StageInfo[];
  itemTypes: Record<string, ItemTypeConfig>;
}

const enc = encodeURIComponent;

export const api = {
  meta: () => request<Meta>("/api/meta"),
  doctor: (stage: string) => request<DoctorCheck[]>(`/api/stages/${enc(stage)}/doctor`),

  items: (stage: string, type: string) =>
    request<{ etag: string; items: Item[] }>(`/api/stages/${enc(stage)}/items/${enc(type)}`),
  saveItem: (stage: string, type: string, id: string, body: { value: unknown; etag?: string }) =>
    request<{ item: Item; etag: string }>(`/api/stages/${enc(stage)}/items/${enc(type)}/${enc(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteItem: (stage: string, type: string, id: string, etag?: string) =>
    request<{ etag: string }>(
      `/api/stages/${enc(stage)}/items/${enc(type)}/${enc(id)}${etag ? `?etag=${enc(etag)}` : ""}`,
      { method: "DELETE" },
    ),

  listStorage: (stage: string, prefix: string) =>
    request<ListResult>(`/api/stages/${enc(stage)}/storage?prefix=${enc(prefix)}`),
  objectUrl: (stage: string, name: string) => `/api/stages/${enc(stage)}/storage/object?name=${enc(name)}`,
  /** Images can't send headers, so previews are fetched as blobs. */
  objectBlob: async (stage: string, name: string): Promise<Blob> => {
    const res = await fetch(api.objectUrl(stage, name), { headers: token ? { "x-emberdeck-token": token } : {} });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.blob();
  },
  upload: (stage: string, name: string, file: File) =>
    request<{ name: string }>(`/api/stages/${enc(stage)}/storage/object?name=${enc(name)}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    }),
  deleteObject: (stage: string, name: string) =>
    request<{ ok: true }>(`/api/stages/${enc(stage)}/storage/object?name=${enc(name)}`, { method: "DELETE" }),

  diff: (from: string, to: string, type: string) =>
    request<ItemDiff[]>(`/api/diff?from=${enc(from)}&to=${enc(to)}&type=${enc(type)}`),
  promote: (body: { from: string; to: string; type: string; ids?: string[]; dryRun?: boolean }) =>
    request<PromoteReport>("/api/promote", { method: "POST", body: JSON.stringify(body) }),
};
