---
"@gtmgrid/desktop": patch
"@gtmgrid/web": patch
---

Ship Linux as `.deb` only (the AppImage bundler's upstream `linuxdeploy` download
returns persistent 504s and failed the release), and ad-hoc sign the macOS app
(`bundle.macOS.signingIdentity: "-"`) so first launch shows the recoverable
"unidentified developer" prompt instead of the "app is damaged" block. The
`/download` page now lists the `.deb` for Linux and shows a macOS first-launch note.
