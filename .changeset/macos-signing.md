---
"@gtmgrid/desktop": patch
---

Sign + notarize the macOS app so downloads open without a Gatekeeper warning.

The release now signs the app with a Developer ID Application certificate and
notarizes it via the App Store Connect API. The bundled Node sidecar (`node`
runtime + `better-sqlite3` native addon) is codesigned under the Hardened
Runtime with JIT/library-validation entitlements so it runs in a notarized
build. Signing is driven by repository secrets (`APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`,
`APPLE_API_KEY_ID`, `APPLE_API_KEY_P8`); releases still build unsigned when they
are absent.
