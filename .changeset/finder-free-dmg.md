---
"@gtmgrid/desktop": patch
---

Package the macOS DMG without Finder so it builds on the self-hosted runner.
Tauri's bundle_dmg.sh drives Finder via AppleScript (times out headless), so the
macOS build now produces the signed+notarized .app (+ updater) and a later step
wraps it in a DMG via hdiutil, then signs + notarizes + staples the DMG.
