---
"@gtmgrid/desktop": patch
---

Fix broken Windows auto-update caused by mis-signing the NSIS installer.

The release workflow set `CSC_LINK` / `CSC_KEY_PASSWORD` / `CSC_IDENTITY_AUTO_DISCOVERY`
on every matrix runner, but these are repo secrets present everywhere — so on the
Windows runner electron-builder grabbed the Apple `.p12` and signed the NSIS installer
with the macOS "Developer ID Application" cert. Windows doesn't trust that cert, so
electron-updater's `verifySignature` (Get-AuthenticodeSignature) rejected every
download and silently stranded 100% of Windows users on their installed version.

The signing env vars are now gated on the mac runners (`matrix.os == 'macos'`) so the
Windows installer is no longer Apple-signed, and `win.verifyUpdateCodeSignature: false`
is set in electron-builder.yml until a real Windows Authenticode certificate is wired
into CI.
