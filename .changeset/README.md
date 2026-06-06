# Changesets

GTM Grid uses [changesets](https://github.com/changesets/changesets) for **semantic
versioning** of the desktop app.

All `@gtmgrid/*` packages are version-locked (`fixed`), so a single version number
tracks the whole product — `@gtmgrid/desktop`'s version is the released app version,
mirrored into `tauri.conf.json` and `Cargo.toml` by `scripts/sync-app-version.mjs`.

## Adding a changeset

When you make a user-facing change, record it:

```bash
pnpm changeset
```

Pick a bump (`patch` / `minor` / `major`) and write a one-line summary. Commit the
generated `.changeset/*.md` file with your PR.

## Cutting a release

Releases are cut from `main` via the **Release** GitHub Action (`workflow_dispatch`),
which runs `pnpm version-packages` (applies pending changesets + syncs versions),
tags `v<version>`, and builds the cross-platform binaries. You don't run this locally.
