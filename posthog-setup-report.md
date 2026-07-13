<wizard-report>
# PostHog post-wizard report

The wizard has completed a full PostHog integration for the GTM Grid marketing site (`apps/web`). PostHog is initialized client-side via `instrumentation-client.ts` (Next.js 15.3+ approach) with a reverse proxy through `/ingest` to avoid ad-blockers. A server-side client in `lib/posthog-server.ts` handles event capture from API routes and tRPC procedures. Eight events were instrumented across five client-side components and two server-side routes.

| Event | Description | File |
|---|---|---|
| `download_initiated` | User clicks a download CTA button; includes `platform` and `os` properties | `apps/web/app/_home/DownloadCTA.tsx` |
| `download_initiated` | User clicks a download button on the /download page | `apps/web/app/DownloadButton.tsx` |
| `pricing_plan_cta_clicked` | User clicks a pricing plan CTA ("Start free" or "Start 7-day trial"); includes `plan` and `billing_period` | `apps/web/app/_home/Pricing.tsx` |
| `billing_period_toggled` | User switches between monthly and annual billing; includes `period` | `apps/web/app/_home/Pricing.tsx` |
| `invite_code_copied` | User copies the invite token on the /invite/[token] page | `apps/web/app/invite/[token]/CopyCode.tsx` |
| `clone_command_copied` | User copies the git clone command from the hero CTA | `apps/web/app/_home/CopyButton.tsx` |
| `billing_checkout_initiated` | Server-side: user triggered a cloud plan checkout via tRPC; includes `workspace_id` and `plan_id` | `apps/web/lib/trpc/routers/billing.ts` |
| `webhook_received` | Server-side: valid inbound webhook accepted; includes `webhook_id`, `workspace_id`, `table_id`, `auto_run`, `mode` | `apps/web/app/api/webhooks/[token]/route.ts` |

**New files created:**
- `apps/web/instrumentation-client.ts` — client-side PostHog init (Next.js 15.3+ instrumentation)
- `apps/web/lib/posthog-server.ts` — singleton server-side PostHog client (`posthog-node`)

**Modified files:**
- `apps/web/next.config.ts` — added `/ingest` reverse proxy rewrites + `skipTrailingSlashRedirect: true`
- `apps/web/package.json` — added `posthog-js` and `posthog-node` dependencies

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics (wizard) — Dashboard](https://eu.posthog.com/project/201747/dashboard/747148)
- [Downloads over time](https://eu.posthog.com/project/201747/insights/TmF9lVWi)
- [Pricing CTA clicks by plan](https://eu.posthog.com/project/201747/insights/UEfrNvM2)
- [Billing checkouts initiated](https://eu.posthog.com/project/201747/insights/JgTlwTCy)
- [Download to checkout conversion funnel](https://eu.posthog.com/project/201747/insights/rRSXHzwl)
- [Webhook adoption over time](https://eu.posthog.com/project/201747/insights/LLu9DGcl)

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
