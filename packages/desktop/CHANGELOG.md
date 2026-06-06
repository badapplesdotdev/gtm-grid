# @gtmgrid/desktop

## 0.2.0

### Minor Changes

- 6158796: Build Windows and macOS Intel installers on release. Windows builds natively
  (the Rust sidecar spawn + bundler are now node.exe-aware and skip unix-only PATH
  probing); macOS Intel is cross-compiled on the Apple-silicon runner with an
  arch-aware sidecar (x64 node + x64 better-sqlite3). Releases now cover macOS
  arm64, macOS Intel, Linux, and Windows.

### Patch Changes

- @gtmgrid/cloud@0.2.0

## 0.1.0

### Minor Changes

- ec7ff47: Add CI (typecheck, lint via oxlint, and tests) and a semantic-versioning release
  pipeline (changesets) that builds downloadable cross-platform desktop binaries
  (macOS arm64 + Intel, Linux) on each release.

### Patch Changes

- @gtmgrid/cloud@0.1.0
