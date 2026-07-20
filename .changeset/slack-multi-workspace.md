---
"@gtmgrid/services": minor
"@gtmgrid/engine": minor
"@gtmgrid/desktop": minor
"@gtmgrid/db": minor
"@gtmgrid/web": minor
---

Connect multiple Slack workspaces to one GTM Grid workspace.

A workspace can now install the Slack app into several Slack teams and pin each
column to the team it posts as. Previously the second connect silently
overwrote the first: every `sdk.slack.*` call across the grid switched team
without a word, and inbound events from the replaced team were dropped as a
tenant mismatch.

- `credentials` gains an `account_id` discriminator, so a connector holds one
  row per connected account and each keeps its own OAuth refresh cycle and
  rotation lock. Slack's refresh tokens are single-use, so sharing a row across
  teams would have made one team's refresh revoke another's live token.
- Columns gain `account_id`. A column that names no account still resolves the
  workspace's sole connection; with several connected it fails with
  `CredentialAccountAmbiguous` rather than posting into an arbitrary team.
- The Slack Events tenant gate now tests membership of every connected team
  instead of equality with one, and still fails closed.
- Fixes a pre-existing race in `CredentialRepo.upsert`: it was a
  select-then-insert with no unique index behind it, so two concurrent connects
  both inserted and every read (`LIMIT 1`) then served an arbitrary row. Now a
  single `ON CONFLICT` statement against two partial unique indexes.
- `slack.disconnect` now requires the `admin` role. It deletes a shared
  credential every teammate's columns run against, and the tokens cannot be
  recovered without a fresh consent round-trip.
