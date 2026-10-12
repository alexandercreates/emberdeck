import { EmberdeckError } from "./errors.js";
import type { TokenProvider } from "./auth/google.js";

export interface AuthedFetchOptions extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
}

/** fetch() with OAuth bearer token and Google-style error mapping. */
export async function authedFetch(
  auth: TokenProvider,
  url: string,
  init: AuthedFetchOptions = {},
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${await auth.getAccessToken()}`,
      ...(await auth.getRequestHeaders()),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      message = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? text);
    } catch {
      // keep raw text
    }
    const code = res.status === 409 || res.status === 412 ? "CONFLICT" : "API_ERROR";
    throw new EmberdeckError(code, `${init.method ?? "GET"} ${url} failed (${res.status}): ${message}`, {
      status: res.status,
    });
  }
  return res;
}
