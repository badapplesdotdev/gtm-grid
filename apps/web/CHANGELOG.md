# @gtmgrid/web

## 0.3.2

### Patch Changes

- 7e1df59: Ship Linux as `.deb` only (the AppImage bundler's upstream `linuxdeploy` download
  returns persistent 504s and failed the release), and ad-hoc sign the macOS app
  (`bundle.macOS.signingIdentity: "-"`) so first launch shows the recoverable
  "unidentified developer" prompt instead of the "app is damaged" block. The
  `/download` page now lists the `.deb` for Linux and shows a macOS first-launch note.
  - @gtmgrid/auth@0.3.2
  - @gtmgrid/cloud@0.3.2
  - @gtmgrid/db@0.3.2
  - @gtmgrid/engine@0.3.2
  - @gtmgrid/services@0.3.2

## 0.3.1

### Patch Changes

- @gtmgrid/auth@0.3.1
- @gtmgrid/cloud@0.3.1
- @gtmgrid/db@0.3.1
- @gtmgrid/engine@0.3.1
- @gtmgrid/services@0.3.1

## 0.3.0

### Patch Changes

- @gtmgrid/auth@0.3.0
- @gtmgrid/cloud@0.3.0
- @gtmgrid/db@0.3.0
- @gtmgrid/engine@0.3.0
- @gtmgrid/services@0.3.0
