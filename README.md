# 🔥 emberdeck

**Manage Firebase Remote Config and Storage across stages — with typed, customizable items.**

emberdeck turns your Remote Config parameters and Storage files into structured content you can
edit from a local dashboard or the CLI. Define your own item types once, and every stage
(`dev`, `staging`, `prod`, …) gets forms, validation, diffs and one-click promotion.

> Status: early development (v0.1). APIs and config format may still change.

## Why

The Firebase console is great for one project and a handful of flat parameters. It gets painful when you

- run several Firebase projects as stages and need to keep them in sync,
- store structured JSON in Remote Config and want forms and validation instead of raw text,
- reference Storage files (images, configs) from Remote Config values,
- want changes reviewed in git and scripted in CI.

## Features

- **Generic, schema-driven items** — define item types with fields (`string`, `number`, `boolean`, `date`, `json`, `object`, `list`, `storageFile`); the dashboard renders forms from them.
- **Multiple stages** — one Firebase project per stage, each with its own credentials.
- **Compare & promote** — see what differs between stages and copy items, including referenced Storage files, in a single publish.
- **Safe publishing** — every write is ETag-guarded, so concurrent edits fail instead of silently overwriting each other. Protected stages ask for confirmation.
- **Storage browser** — browse, upload and delete files per stage.
- **Local-first** — `emberdeck studio` runs on `127.0.0.1` with a per-session token. Your credentials never leave your machine; there is nothing to host.
- **Zero runtime dependencies** in the core and CLI (only Node.js built-ins).

## Install

```bash
# npm / npx (Node.js >= 22.18)
npx emberdeck init
npm install -D emberdeck   # optional, gives you config autocompletion

# Homebrew (single binary, no Node.js needed)
brew install alexandercreates/tap/emberdeck
```

Prebuilt binaries for macOS and Linux are also attached to every
[GitHub release](https://github.com/alexandercreates/emberdeck/releases).

## Quick start

```bash
npx emberdeck init      # creates emberdeck.config.ts
npx emberdeck doctor    # checks credentials and permissions for every stage
npx emberdeck studio    # opens the dashboard
```

## Configuration

```ts
// emberdeck.config.ts
import type { EmberdeckConfig } from "emberdeck";

export default {
  stages: {
    dev: {
      projectId: "my-app-dev",
      bucket: "my-app-dev.firebasestorage.app",
      credentials: { type: "serviceAccount", file: "./.emberdeck/credentials/dev.json" },
    },
    prod: {
      projectId: "my-app-prod",
      bucket: "my-app-prod.firebasestorage.app",
      protected: true,
      credentials: { type: "adc", impersonate: "emberdeck@my-app-prod.iam.gserviceaccount.com" },
    },
  },
  items: {
    banner: {
      label: "Banner",
      // `{id}` makes this a collection: banner_summer, banner_black_friday, …
      target: { remoteConfig: { key: "banner_{id}", group: "marketing" } },
      fields: {
        title: { type: "string", required: true, maxLength: 60 },
        active: { type: "boolean", default: false },
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
    featureFlags: {
      // No `{id}`: a singleton stored in exactly one parameter.
      target: { remoteConfig: { key: "feature_flags" } },
      fields: { newCheckout: { type: "boolean", default: false } },
    },
  },
} satisfies EmberdeckConfig;
```

`.mjs`, `.js` and `.json` configs work too.

### How items are stored

Each item is one Remote Config parameter with `valueType: JSON`. The parameter value is the
item as a JSON object, so your apps read it with the regular Firebase SDK. Conditional values
are kept when you edit an item. Parameters that don't belong to an item type are never touched.

### Credentials

| Type | Config | When to use |
| --- | --- | --- |
| Service account file | `{ type: "serviceAccount", file: "./sa.json" }` | Quick local setup. Keep the file out of git. |
| Service account from env | `{ type: "serviceAccount", env: "PROD_SA_JSON" }` | CI. The variable holds the key JSON. |
| Application Default Credentials | `{ type: "adc" }` | Your own Google account via `gcloud`. |
| ADC + impersonation | `{ type: "adc", impersonate: "sa@…" }` | Recommended for teams: no key files at all. |

For ADC, log in with the scopes emberdeck needs:

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/firebase.remoteconfig,https://www.googleapis.com/auth/devstorage.read_write,https://www.googleapis.com/auth/cloud-platform
```

The identity needs **Firebase Remote Config Admin** and, if you use Storage, **Storage Object Admin**
on the project. `emberdeck doctor` tells you what is missing.

## CLI

```text
emberdeck init                               Create emberdeck.config.ts
emberdeck studio [--port 4321] [--no-open]   Start the local dashboard
emberdeck stages | types                     Show configured stages / item types
emberdeck doctor [--stage prod]              Check credentials and permissions
emberdeck items banner --stage dev           List items
emberdeck get banner summer                  Print one item as JSON
emberdeck set banner summer --file x.json    Create or update an item
emberdeck rm banner summer                   Delete an item
emberdeck diff dev prod --type banner        Compare two stages
emberdeck promote dev prod --type banner --id summer [--dry-run]
emberdeck rc pull --stage prod               Print the raw Remote Config template
```

All read commands support `--json`.

## Programmatic use

```ts
import { Workspace } from "emberdeck";

const ws = await Workspace.load();
const dev = await ws.stage("dev");
await dev.saveItem("banner", "summer", { value: { title: "Summer Sale" } });
await ws.promote({ from: "dev", to: "prod", type: "banner", ids: ["summer"] });
```

## Development

```bash
pnpm install
pnpm build            # core + cli (tsc) and the dashboard (vite)
pnpm test             # unit + integration tests against an in-memory fake of the Google APIs
pnpm dev:cli --help
pnpm build:binaries --targets linux-x64   # single-file binary, needs bun
```

Releases are fully automated from version tags, see [docs/RELEASING.md](docs/RELEASING.md).

Dashboard development: run `emberdeck studio --port 4321 --no-open` inside a project, then
`pnpm dev:dashboard` and open `http://localhost:5173/#token=<token from the studio URL>`.

### Repository layout

```text
packages/
  core/        @emberdeck/core — config, auth, Remote Config + Storage clients, items, diff, promote
  cli/         emberdeck — CLI and the local studio server (published package)
  dashboard/   @emberdeck/dashboard — React UI, bundled into the CLI package
```

## Roadmap

- [x] Single-file binaries with embedded dashboard, Homebrew tap, npm publishing ([docs/RELEASING.md](docs/RELEASING.md))
- [ ] Windows binary
- [ ] Remote Config version history and rollback in the dashboard
- [ ] Conditional values editor
- [ ] Credentials in the OS keychain
- [ ] `emberdeck codegen` — TypeScript, Swift and Kotlin types from item schemas
- [ ] Raw mode for parameters that don't belong to an item type
- [ ] Storage-only item types (items stored as JSON files in Storage)

## License

MIT © [Alexander Frank-Puchta](https://alexandercreates.org)
