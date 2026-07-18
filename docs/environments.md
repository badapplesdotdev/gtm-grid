# Environments

Two long-lived branches, two databases, two sets of OAuth apps.

| | `main` | `staging` |
|---|---|---|
| Role | **production** | pre-production |
| Vercel | Production deployment (`www.gtmgrid.dev`) | its own deployment |
| Database | production Supabase project | Supabase **persistent branch** `staging` |
| Migrations | `migrate-prod.yml` (`PROD_DATABASE_URL`) | `migrate-staging.yml` (`STAGING_DATABASE_URL`) |
| CI | `ci.yml` | `ci.yml` |
| Desktop releases | `release.yml` cuts from here | never |

`main` stays production. That was deliberate: making `main` staging would have
meant retargeting `release.yml` — which hardcodes `ref: main` and
`git push origin main` — and getting it wrong ships **staging code to users as a
production desktop release**. Keeping `main` as production leaves `release.yml`
and `migrate-prod.yml` untouched, which are the two files where a mistake is
least recoverable.

## The couplings that will bite

**The `staging` branch name is load-bearing.** The Supabase persistent branch is
git-linked *by name*. Rename or delete the git branch and the two silently stop
corresponding: `migrate-staging.yml` keeps passing while staging's schema drifts
from the code.

**A Supabase branch starts EMPTY.** Branching replays `supabase/migrations/`,
which this repo does not have — the schema is built by Drizzle migrations in
`packages/db/migrations`. That is the entire reason `migrate-staging.yml` exists.
A brand-new branch has no tables until it runs.

**Staging needs its own OAuth apps.** Redirect URLs are per-origin, so a Slack /
Attio / HubSpot app registered against production will not accept staging's
callback. Register a second app per provider and give staging its own
`*_CLIENT_ID` / `*_CLIENT_SECRET`.

**Staging must have its own `CREDENTIALS_MASTER_KEY`.** It encrypts stored OAuth
tokens. Because staging has a separate database this is safe and correct — a
distinct key means a leaked staging key cannot decrypt production credentials.
(Sharing a database while using different keys would be the broken case: staging
would write rows production cannot decrypt.)

## Known gap: Preview points at the production database

Vercel's **Preview** environment currently has `DATABASE_URL` and
`WEBHOOK_WORKER_SECRET` identical to Production — verified by fingerprint. Every
branch preview therefore reads and writes production data.

It has not caused damage only by accident: Preview lacks `BETTER_AUTH_SECRET`,
`CREDENTIALS_MASTER_KEY` and `SITE_URL`, so the routes that would write 500
first. **Do not "fix" those 500s by adding the missing vars to Preview** — that
removes the accidental safety net and points every PR preview at production.

The fix is to repoint Preview's `DATABASE_URL` at the staging branch database and
rotate Preview's `WEBHOOK_WORKER_SECRET` so it differs from production. Tracked,
not yet done.

## Adding a secret

Repo secrets (GitHub → Settings → Secrets → Actions):

- `PROD_DATABASE_URL` — production Supabase pooled string (port 6543)
- `STAGING_DATABASE_URL` — the `staging` Supabase branch's pooled string

Vercel env vars are per-environment; set staging's under its own environment, not
Production, and never reuse a production value except where it is deliberately
shared.
