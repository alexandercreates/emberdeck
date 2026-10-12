import { randomBytes } from "node:crypto";
import { authedFetch } from "../http.js";
import type { TokenProvider } from "../auth/google.js";

export interface StorageObject {
  name: string;
  bucket: string;
  size: number;
  contentType?: string;
  updated?: string;
  md5Hash?: string;
  metadata?: Record<string, string>;
}

export interface ListResult {
  objects: StorageObject[];
  /** "Folders" when listing with a delimiter. */
  prefixes: string[];
  nextPageToken?: string;
}

interface RawObject {
  name: string;
  bucket: string;
  size?: string;
  contentType?: string;
  updated?: string;
  md5Hash?: string;
  metadata?: Record<string, string>;
}

const toObject = (o: RawObject): StorageObject => ({
  name: o.name,
  bucket: o.bucket,
  size: Number(o.size ?? 0),
  contentType: o.contentType,
  updated: o.updated,
  md5Hash: o.md5Hash,
  metadata: o.metadata,
});

/** Client for the Cloud Storage JSON API, scoped to one bucket. */
export class StorageClient {
  private readonly api: string;
  private readonly upload: string;

  constructor(
    private readonly auth: TokenProvider,
    readonly bucket: string,
    baseUrl = "https://storage.googleapis.com",
  ) {
    this.api = `${baseUrl}/storage/v1/b/${encodeURIComponent(bucket)}/o`;
    this.upload = `${baseUrl}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`;
  }

  async list(options: { prefix?: string; delimiter?: string; pageToken?: string; maxResults?: number } = {}): Promise<ListResult> {
    const params = new URLSearchParams();
    if (options.prefix) params.set("prefix", options.prefix);
    if (options.delimiter) params.set("delimiter", options.delimiter);
    if (options.pageToken) params.set("pageToken", options.pageToken);
    params.set("maxResults", String(options.maxResults ?? 1000));
    const res = await authedFetch(this.auth, `${this.api}?${params}`);
    const json = (await res.json()) as { items?: RawObject[]; prefixes?: string[]; nextPageToken?: string };
    return {
      objects: (json.items ?? []).map(toObject),
      prefixes: json.prefixes ?? [],
      nextPageToken: json.nextPageToken,
    };
  }

  /** Lists every object below `prefix`, following pagination. */
  async listAll(prefix?: string): Promise<StorageObject[]> {
    const all: StorageObject[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.list({ prefix, pageToken });
      all.push(...page.objects);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return all;
  }

  async stat(name: string): Promise<StorageObject | undefined> {
    try {
      const res = await authedFetch(this.auth, `${this.api}/${encodeURIComponent(name)}`);
      return toObject((await res.json()) as RawObject);
    } catch (err) {
      if ((err as { details?: { status?: number } }).details?.status === 404) return undefined;
      throw err;
    }
  }

  async download(name: string): Promise<{ data: Buffer; contentType?: string }> {
    const res = await authedFetch(this.auth, `${this.api}/${encodeURIComponent(name)}?alt=media`);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? undefined,
    };
  }

  /** Uploads (or replaces) an object together with its custom metadata. */
  async put(
    name: string,
    data: Buffer | Uint8Array,
    options: { contentType?: string; metadata?: Record<string, string>; cacheControl?: string } = {},
  ): Promise<StorageObject> {
    const contentType = options.contentType ?? "application/octet-stream";
    const boundary = `emberdeck-${randomBytes(12).toString("hex")}`;
    const meta = {
      name,
      contentType,
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(options.cacheControl ? { cacheControl: options.cacheControl } : {}),
    };
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
          `--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`,
      ),
      Buffer.from(data),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await authedFetch(this.auth, `${this.upload}?uploadType=multipart`, {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return toObject((await res.json()) as RawObject);
  }

  async updateMetadata(name: string, metadata: Record<string, string | null>): Promise<StorageObject> {
    const res = await authedFetch(this.auth, `${this.api}/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata }),
    });
    return toObject((await res.json()) as RawObject);
  }

  async delete(name: string): Promise<void> {
    await authedFetch(this.auth, `${this.api}/${encodeURIComponent(name)}`, { method: "DELETE" });
  }
}
