# Observability & Production Readiness

GTM Grid uses **PostHog** (EU, project `201747`) as the single backbone for product
analytics, error tracking, web/revenue analytics, surveys, and support. This is the
operator's runbook: what's instrumented, how to configure it, and how to triage.

## Configuration (env vars)

| Surface | Vars | Notes |
|---|---|---|
| Web (`apps/web`, Next) | `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, `NEXT_PUBLIC_POSTHOG_HOST` | Build-inlined; ingestion proxied via `/ingest` (see `next.config.ts`). |
| Desktop (`packages/desktop`, Vite) | `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` | Native webview → **absolute** ingest host (no same-origin proxy). |
| Sidecar (`packages/server`, Node) | `GTMGRID_POSTHOG_KEY`, `GTMGRID_POSTHOG_HOST` | Tauri passes these to the spawned sidecar. |
| PartyKit (`apps/party`, CF Workers) | `POSTHOG_KEY`, `POSTHOG_HOST` | Set in the party deploy env. |

**Every surface no-ops when its key is unset** — local/OSS builds run untouched. All
keys are the same public PostHog project token (`phc_...`).

## What's instrumented

- **Product analytics** — typed against the shared catalog in
  `packages/analytics/src/events.ts` (the single source of truth; never capture raw
  event strings). Web marketing events + desktop product events (`app_opened`,
  `table_created`, `column_run`, `agent_turn_completed`, `ask_user_question_answered`,
  …) + `realtime_connected` from PartyKit.
- **Error tracking** (PostHog Error Tracking, no Sentry):
  - Web client: `capture_exceptions` + `error.tsx` / `global-error.tsx` boundaries.
  - Web server: tRPC `onError`, `instrumentation.ts` `onRequestError`, worker 500s,
    Inngest `onFailure` on all durable functions.
  - Desktop: `ErrorBoundary` + posthog-js autocapture.
  - Sidecar: `captureException` on route 500s + `uncaughtException`/`unhandledRejection`
    handlers (`packages/server/src/observability.ts`).
- **Identify / groups** — desktop identifies the signed-in user and groups by
  `workspace` (`PostHogIdentityBridge`); server events carry `distinctId` + workspace
  group. (Web has no client auth UI, so client identify lives in the desktop app.)
- **Web Analytics** — pageviews, pageleave, web vitals via `defaults: "2026-01-30"`.
- **Surveys / Support** — render automatically once authored in PostHog (SDK loaded).
- **Revenue** — `subscription_*` events (catalog) are emitted by the billing webhook
  (see Deferred) and/or PostHog's Stripe → Revenue Analytics connector.
- **Structured logs** — sidecar `log.info/warn/error` (JSON to stderr; errors → PostHog).

## Triage

- **An error spiked** → PostHog → Error Tracking. Group by `source` property
  (`trpc` / `next` / `worker` / `inngest` / `sidecar-route`) to locate the surface.
  Server errors carry the user `distinctId` + path.
- **A user reports a bug** → identify them in PostHog by email, view their events /
  exceptions timeline.
- **Is the web app healthy?** → `GET /healthz` (liveness), `GET /readyz` (DB-depth;
  503 when the DB is unreachable).

## Production hardening (Phase 5)

- Security headers on every web response (`next.config.ts` `headers()`).
- Rate limiting on the public webhook ingress (`lib/rate-limit.ts`; 120/60s per
  token+IP). **Per-instance soft limit** — swap for `@upstash/ratelimit` for a
  distributed guarantee.
- CI builds the web app (`next build`) so broken builds fail before release.

## PostHog-app config to create (Phase 6 — via PostHog MCP or UI)

These are dashboards/objects authored in PostHog, not code:

1. **Activation funnel** dashboard: `app_opened` → `table_created` → `column_run` →
   `cloud_sync_completed`.
2. **Error-tracking alert**: notify on an exception-volume spike.
3. **Revenue** dashboard from the `subscription_*` events (or the Stripe connector).
4. **Agent usage** insight: `agent_turn_completed` by `agent` + outcome.
5. **Surveys**: a post-onboarding / NPS survey targeted by cohort.

## Deferred / follow-ups

- **Session Replay** — off pending a privacy review (desktop/web show customer PII);
  enable with mask-all-inputs when revisited.
- **LLM Analytics** — instrument `ai.generate` + the agent panel with PostHog LLM
  observability (cost/latency/tokens).
- **Feature Flags** — wire the flag SDK for gated rollouts / kill-switches.
- **Billing webhook** — add an Autumn/Stripe webhook route to revoke entitlements on
  out-of-app cancellations and emit `subscription_*` revenue events. Needs Autumn's
  webhook signing secret + payload contract; integration point is
  `BillingService.syncPlan` (`packages/services/src/services/billing-service.ts`).
- **Worker REST zod validation** — replace the `readJson<T>` casts in
  `app/api/worker/_lib.ts` with zod-parsed bodies (incremental across ~25 routes).
- **Content-Security-Policy** — add once tested against PostHog/Supabase/OAuth.
- **PostHog Logs (OTel)** — ship structured sidecar logs to PostHog's Logs product via
  an OpenTelemetry exporter (today errors feed Error Tracking).
