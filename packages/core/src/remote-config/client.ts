import { authedFetch } from "../http.js";
import type { TokenProvider } from "../auth/google.js";
import { toPublishable, type RemoteConfigTemplate, type RemoteConfigVersion } from "./template.js";

export interface TemplateWithEtag {
  template: RemoteConfigTemplate;
  etag: string;
}

export interface PublishOptions {
  /** ETag from the template you based your changes on. Use "*" to force. */
  etag: string;
  /** Validate only, don't publish. */
  validateOnly?: boolean;
  /** Version description shown in the Firebase console history. */
  description?: string;
}

/**
 * Thin client for the Remote Config REST API v1.
 * Publishing uses If-Match so concurrent edits fail loudly instead of
 * silently overwriting each other.
 */
export class RemoteConfigClient {
  private readonly base: string;

  constructor(
    private readonly auth: TokenProvider,
    readonly projectId: string,
    baseUrl = "https://firebaseremoteconfig.googleapis.com/v1",
  ) {
    this.base = `${baseUrl}/projects/${encodeURIComponent(projectId)}/remoteConfig`;
  }

  async getTemplate(versionNumber?: string): Promise<TemplateWithEtag> {
    const url = versionNumber ? `${this.base}?versionNumber=${encodeURIComponent(versionNumber)}` : this.base;
    const res = await authedFetch(this.auth, url, { headers: { "accept-encoding": "gzip" } });
    const etag = res.headers.get("etag") ?? "*";
    return { template: (await res.json()) as RemoteConfigTemplate, etag };
  }

  async publish(template: RemoteConfigTemplate, options: PublishOptions): Promise<TemplateWithEtag> {
    const body = toPublishable(template);
    if (options.description) body.version = { description: options.description };
    const url = options.validateOnly ? `${this.base}?validateOnly=true` : this.base;
    const res = await authedFetch(this.auth, url, {
      method: "PUT",
      headers: {
        "content-type": "application/json; UTF-8",
        "if-match": options.etag,
      },
      body: JSON.stringify(body),
    });
    return {
      template: (await res.json()) as RemoteConfigTemplate,
      etag: res.headers.get("etag") ?? options.etag,
    };
  }

  async listVersions(pageSize = 50): Promise<RemoteConfigVersion[]> {
    const res = await authedFetch(this.auth, `${this.base}:listVersions?pageSize=${pageSize}`);
    const json = (await res.json()) as { versions?: RemoteConfigVersion[] };
    return json.versions ?? [];
  }

  async rollback(versionNumber: string): Promise<TemplateWithEtag> {
    const res = await authedFetch(this.auth, `${this.base}:rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionNumber }),
    });
    return {
      template: (await res.json()) as RemoteConfigTemplate,
      etag: res.headers.get("etag") ?? "*",
    };
  }
}
