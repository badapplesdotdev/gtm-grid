---
"@gtmgrid/desktop": patch
---

Release pipeline reliability: serialize the per-platform desktop builds so every
release ships binaries + an auto-updater entry for all platforms. The concurrent
build matrix raced on the shared GitHub release (asset uploads + `latest.json`
read-modify-write), which intermittently dropped the macOS-Intel and Windows
artifacts from a release while all jobs still reported success (e.g. v0.3.10).
This re-cut delivers a complete all-platform build.
