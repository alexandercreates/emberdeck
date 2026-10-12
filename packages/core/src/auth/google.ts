import { createSign } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { EmberdeckError } from "../errors.js";
import type { CredentialsConfig } from "../config/types.js";

/**
 * Minimal, dependency-free Google OAuth2 token provider.
 *
 * Supports service account keys (JWT bearer flow), Application Default
 * Credentials of type `authorized_user` and service account impersonation.
 */

export const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/firebase.remoteconfig",
  "https://www.googleapis.com/auth/devstorage.read_write",
  "https://www.googleapis.com/auth/cloud-platform",
];

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface AccessToken {
  token: string;
  /** Epoch millis. */
  expiresAt: number;
}

export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /** Extra headers every request must carry (e.g. quota project for user credentials). */
  getRequestHeaders(): Promise<Record<string, string>>;
  /** Human readable identity, for `emberdeck doctor`. */
  describe(): Promise<string>;
}

interface ServiceAccountKey {
  type: "service_account";
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

interface AuthorizedUserKey {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
}

type CredentialFile = ServiceAccountKey | AuthorizedUserKey | { type: string };

const base64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Builds the signed JWT assertion for the service account JWT bearer flow. */
export function createServiceAccountAssertion(
  key: Pick<ServiceAccountKey, "client_email" | "private_key" | "token_uri">,
  scopes: string[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: scopes.join(" "),
      aud: key.token_uri ?? GOOGLE_TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = base64url(signer.sign(key.private_key));
  return `${header}.${claims}.${signature}`;
}

async function postForm(url: string, body: Record<string, string>): Promise<AccessToken> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new EmberdeckError(
      "AUTH_FAILED",
      `Token request failed (${res.status}): ${json.error_description ?? json.error ?? "unknown error"}`,
    );
  }
  return { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
}

abstract class CachingProvider implements TokenProvider {
  private cached?: AccessToken;
  private inflight?: Promise<AccessToken>;

  protected abstract fetchToken(): Promise<AccessToken>;
  abstract describe(): Promise<string>;

  async getRequestHeaders(): Promise<Record<string, string>> {
    return {};
  }

  async getAccessToken(): Promise<string> {
    // Refresh one minute before expiry.
    if (this.cached && this.cached.expiresAt - 60_000 > Date.now()) return this.cached.token;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    this.cached = await this.inflight;
    return this.cached.token;
  }
}

class ServiceAccountProvider extends CachingProvider {
  constructor(
    private readonly key: ServiceAccountKey,
    private readonly scopes: string[],
  ) {
    super();
  }

  protected fetchToken(): Promise<AccessToken> {
    const assertion = createServiceAccountAssertion(this.key, this.scopes);
    return postForm(this.key.token_uri ?? GOOGLE_TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
  }

  async describe(): Promise<string> {
    return `service account ${this.key.client_email}`;
  }
}

class AuthorizedUserProvider extends CachingProvider {
  constructor(private readonly key: AuthorizedUserKey) {
    super();
  }

  protected fetchToken(): Promise<AccessToken> {
    return postForm(GOOGLE_TOKEN_URL, {
      grant_type: "refresh_token",
      client_id: this.key.client_id,
      client_secret: this.key.client_secret,
      refresh_token: this.key.refresh_token,
    });
  }

  override async getRequestHeaders(): Promise<Record<string, string>> {
    return this.key.quota_project_id ? { "x-goog-user-project": this.key.quota_project_id } : {};
  }

  async describe(): Promise<string> {
    return "application default credentials (user)";
  }
}

class ImpersonatingProvider extends CachingProvider {
  constructor(
    private readonly source: TokenProvider,
    private readonly serviceAccount: string,
    private readonly scopes: string[],
  ) {
    super();
  }

  protected async fetchToken(): Promise<AccessToken> {
    const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(
      this.serviceAccount,
    )}:generateAccessToken`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.source.getAccessToken()}`,
        "content-type": "application/json",
        ...(await this.source.getRequestHeaders()),
      },
      body: JSON.stringify({ scope: this.scopes, lifetime: "3600s" }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      accessToken?: string;
      expireTime?: string;
      error?: { message?: string };
    };
    if (!res.ok || !json.accessToken) {
      throw new EmberdeckError(
        "AUTH_FAILED",
        `Impersonation of ${this.serviceAccount} failed (${res.status}): ${json.error?.message ?? "unknown error"}. ` +
          `Your account needs roles/iam.serviceAccountTokenCreator on that service account.`,
      );
    }
    return {
      token: json.accessToken,
      expiresAt: json.expireTime ? Date.parse(json.expireTime) : Date.now() + 3600_000,
    };
  }

  async describe(): Promise<string> {
    return `${await this.source.describe()} impersonating ${this.serviceAccount}`;
  }
}

function providerFromKey(key: CredentialFile, scopes: string[], origin: string): TokenProvider {
  if (key.type === "service_account") return new ServiceAccountProvider(key as ServiceAccountKey, scopes);
  if (key.type === "authorized_user") return new AuthorizedUserProvider(key as AuthorizedUserKey);
  throw new EmberdeckError("AUTH_FAILED", `Unsupported credential type "${key.type}" in ${origin}.`);
}

/** Location of the gcloud ADC file. */
export function defaultAdcPath(): string {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "gcloud", "application_default_credentials.json");
  }
  return join(homedir(), ".config", "gcloud", "application_default_credentials.json");
}

async function readJsonFile(path: string): Promise<CredentialFile> {
  if (!existsSync(path)) {
    throw new EmberdeckError("AUTH_FAILED", `Credentials file not found: ${path}`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as CredentialFile;
  } catch (err) {
    throw new EmberdeckError("AUTH_FAILED", `Could not parse credentials file ${path}: ${(err as Error).message}`);
  }
}

export async function createTokenProvider(
  credentials: CredentialsConfig,
  options: { rootDir: string; scopes?: string[] },
): Promise<TokenProvider> {
  const scopes = options.scopes ?? DEFAULT_SCOPES;

  if (credentials.type === "serviceAccount") {
    if ("env" in credentials) {
      const value = process.env[credentials.env];
      if (!value) {
        throw new EmberdeckError("AUTH_FAILED", `Environment variable ${credentials.env} is not set.`);
      }
      let key: CredentialFile;
      try {
        key = JSON.parse(value) as CredentialFile;
      } catch {
        throw new EmberdeckError("AUTH_FAILED", `${credentials.env} does not contain valid JSON.`);
      }
      return providerFromKey(key, scopes, `$${credentials.env}`);
    }
    const path = isAbsolute(credentials.file) ? credentials.file : resolve(options.rootDir, credentials.file);
    return providerFromKey(await readJsonFile(path), scopes, path);
  }

  // ADC
  const adcPath = defaultAdcPath();
  if (!existsSync(adcPath)) {
    throw new EmberdeckError(
      "AUTH_FAILED",
      `No Application Default Credentials found at ${adcPath}. Run:\n` +
        `  gcloud auth application-default login --scopes=${DEFAULT_SCOPES.join(",")}`,
    );
  }
  const base = providerFromKey(await readJsonFile(adcPath), scopes, adcPath);
  return credentials.impersonate ? new ImpersonatingProvider(base, credentials.impersonate, scopes) : base;
}
