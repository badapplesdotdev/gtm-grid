---
"@gtmgrid/desktop": minor
---

Self-host support + a one-command local-run flow.

A self-hosted instance (`GTMGRID_SELF_HOST=1`) now works indefinitely and is never
locked out: the env flag bypasses the paid cloud-access gate
(`EntitlementService.requireCloudAccess` — the plan/trial hard-block that otherwise
threw `PlanRequiredError` on every cloud path once a workspace fell to Free or its
trial lapsed) and the cloud-actions usage caps (the bulk-import and webhook
`assertQuota` pre-checks). The desktop UI honors it too — `workspaces.me` now
reports `selfHost` per workspace, and the renderer never shows the "Cloud is
locked" / upgrade prompts when it is set, so a self-hoster's grid stays fully
usable while the backend serves every request.

Running locally is now straightforward: a `docker-compose.yml` brings up just
Postgres, and the README documents the three-step flow (Postgres → migrate → run
backend + sidecar + desktop). Positioning is corrected to match reality
(source-available + self-hostable, with managed cloud as the zero-ops option)
rather than the previous "local-first" claim.

Covered by new unit tests (the `isSelfHost` helper, the entitlement bypass for
Free/lapsed/missing workspaces, the over-quota import/run bypasses, and
`workspaces.me` surfacing `selfHost`) and a new Electron E2E spec
(`self-host.spec.ts`) asserting Free, expired-by-date, and fully-lapsed workspaces
all stay unlocked under self-host — with the existing trial/boot lock specs still
passing when self-host is off.
