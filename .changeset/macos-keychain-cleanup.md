---
"@gtmgrid/desktop": patch
---

Fix macOS signing on the self-hosted runner: delete the leftover `signing_temp`
keychain before importing the Developer ID cert. The Mac mini persists state
between runs (and between the two macOS jobs of one run), so the lingering
keychain made `import-codesign-certs` fail with `security` exit code 48.
