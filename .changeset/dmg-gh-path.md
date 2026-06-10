---
"@gtmgrid/desktop": patch
---

Fix the macOS DMG upload on the self-hosted runner by adding Homebrew's bin to
PATH so `gh` is found (the runner's service PATH is minimal). The DMG already
builds + signs + notarizes + staples correctly; only the upload step failed with
`gh: command not found`.
