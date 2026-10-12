import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE_NAMES } from "@emberdeck/core";

export const CONFIG_TEMPLATE_TS = `// Type-only import: works even when emberdeck is not installed locally (npx / Homebrew).
// Install it as a dev dependency to get autocompletion.
import type { EmberdeckConfig } from "emberdeck";

export default {
  stages: {
    dev: {
      projectId: "my-app-dev",
      bucket: "my-app-dev.firebasestorage.app",
      // Service account key on disk (keep it out of git!) ...
      credentials: { type: "serviceAccount", file: "./.emberdeck/credentials/dev.json" },
    },
    prod: {
      projectId: "my-app-prod",
      bucket: "my-app-prod.firebasestorage.app",
      protected: true,
      // ... or your gcloud login, optionally impersonating a service account.
      credentials: { type: "adc", impersonate: "emberdeck@my-app-prod.iam.gserviceaccount.com" },
    },
  },

  items: {
    // A collection: every banner is stored as Remote Config parameter "banner_<id>".
    banner: {
      label: "Banner",
      target: { remoteConfig: { key: "banner_{id}", group: "marketing" } },
      fields: {
        title: { type: "string", required: true, maxLength: 60 },
        active: { type: "boolean", default: false },
        priority: { type: "number", min: 0, integer: true },
        image: { type: "storageFile", path: "banners/{id}/", accept: "image/*" },
        cta: {
          type: "object",
          fields: {
            label: { type: "string" },
            url: { type: "string", pattern: "^https://" },
          },
        },
      },
    },

    // A singleton: exactly one parameter "feature_flags".
    featureFlags: {
      label: "Feature flags",
      target: { remoteConfig: { key: "feature_flags" } },
      fields: {
        newCheckout: { type: "boolean", default: false },
        maxCartItems: { type: "number", default: 50 },
      },
    },
  },
} satisfies EmberdeckConfig;
`;

export async function initConfig(cwd: string, options: { force?: boolean }): Promise<string> {
  const existing = CONFIG_FILE_NAMES.map((n) => join(cwd, n)).find((p) => existsSync(p));
  if (existing && !options.force) {
    throw new Error(`A config already exists: ${existing} (use --force to overwrite)`);
  }
  const path = join(cwd, "emberdeck.config.ts");
  await writeFile(path, CONFIG_TEMPLATE_TS, "utf8");
  return path;
}
