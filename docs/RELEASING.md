# Releasing emberdeck

A release is triggered by pushing a `v*` tag. The [release workflow](../.github/workflows/release.yml)
then

1. verifies that all package versions match the tag, builds and runs the tests,
2. compiles single-file binaries with the dashboard embedded (macOS on macOS runners so they can be codesigned, Linux on Ubuntu),
3. creates a GitHub release with the archives and `checksums.txt`,
4. publishes `@emberdeck/core` and `emberdeck` to npm (with provenance),
5. updates the formula in the Homebrew tap.

Tags with a pre-release suffix (`v0.2.0-beta.1`) become GitHub pre-releases, are published to npm
under the `next` dist-tag and don't touch the Homebrew formula.

## Cutting a release

```bash
node scripts/set-version.mjs 0.2.0
git commit -am "Release v0.2.0"
git tag v0.2.0
git push --follow-tags
```

## One-time setup

### npm

1. Make sure the names are available (`npm view emberdeck`, `npm view @emberdeck/core` → 404).
2. Create the `emberdeck` organization on npmjs.com for the `@emberdeck` scope.
3. Create an **automation** access token and store it as the repository secret `NPM_TOKEN`.

If `emberdeck` is taken, rename the CLI package (e.g. `@emberdeck/cli`) in
`packages/cli/package.json` and the publish filter in the workflow. The binary name stays `emberdeck`.

### Homebrew tap

1. Create the public repository `alexandercreates/homebrew-tap` with an empty `Formula/` folder.
2. Create a fine-grained personal access token with **Contents: read and write** on that repository only.
3. Store it as the repository secret `HOMEBREW_TAP_TOKEN` in `alexandercreates/emberdeck`.

Users then install with:

```bash
brew install alexandercreates/tap/emberdeck
```

## Building binaries locally

Requires [Bun](https://bun.sh).

```bash
pnpm build
pnpm build:binaries --targets darwin-arm64   # or omit --targets for all
node scripts/render-formula.mjs                  # prints the formula for dist-bin/checksums.txt
```

macOS binaries must be built on macOS; on other hosts they can't be codesigned and won't start on
Apple Silicon.
