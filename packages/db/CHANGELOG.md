# @gtmgrid/db

## 1.14.0

### Minor Changes

- a5bb8fc: Add Google Sheets as a shared OAuth connector and synced table source.

  Connect Google once, select spreadsheets through Google Picker, import a tab
  into an existing grid, and keep rows matched across scheduled or manual syncs.
  The desktop now refreshes imported data immediately and shows each Sheet
  binding's row count, schedule, errors, and latest manual-sync result.

## 1.13.1

### Patch Changes

- 2582c3a: Fix large CRM imports timing out or remaining stuck in a syncing state.

  CRM pulls now checkpoint each provider page into a fresh durable Inngest run,
  heartbeat active syncs so healthy long-running imports are not reaped, and stop
  finalized or paused continuations before they can write duplicate rows. The
  checkpoint carries the run schema, row budget, and actor cache so large Attio
  and HubSpot sources avoid repeated metadata calls and unbounded Inngest state.

## 1.13.0

### Minor Changes

- 6299102: Bring back the Auto-run toggle, and let agents drive it.

  The toolbar's Auto-run switch disappeared in "remove the local paradigm" (#126).
  That change deleted the local grid, which was the only thing that ever passed
  `autoRun` into `DataGrid` — the switch itself, and its CSS, survived untouched,
  so the control was rendered conditionally on a prop nobody supplied any more. The
  gate it enforced went with it: since then every cloud cascade has run every
  dependent column, billed connectors included, with no way to say no.

  Auto-run is now a persisted, workspace-shared property of the table
  (`tables.auto_run`, `NOT NULL DEFAULT true`) rather than a per-browser
  `localStorage` flag, because it governs shared credit spend — it has to mean the
  same thing for every member, for the server-side webhook worker, and for an agent
  driving the grid.
  - **The switch is back** in the grid toolbar, reading and writing the persisted
    flag. Toggling is optimistic through the same reducer the realtime
    `table.autoRun` event uses, so it flips instantly and every other member's grid
    follows live.
  - **Auto-run off stops billed cascades**, not the grid. Formula, mapped and code
    columns still cascade for free; only columns that dispatch a billable connector
    call wait for an explicit run. Running a billed column by hand still fills the
    free columns downstream of it.
  - **Inbound webhooks respect it too.** A table's auto-run ANDs with the
    connection's own flag — an HTTP-delivered row is the one path that spends
    credits with nobody watching, so "nothing in this table enriches itself" now
    holds there as well. The row still lands; only the enrichment is withheld.
  - **Agents can read and set it** via a new `set_auto_run` MCP tool (and `autoRun`
    on `get_table`), so an agent can turn it off before rewriting column configs or
    bulk-loading rows and turn it back on when the table is ready. It is the same
    switch the user sees, so the two can never disagree.

  Existing tables migrate to auto-run ON, which is exactly what they have been
  doing, so nothing changes until someone turns it off.

## 1.12.0

### Minor Changes

- 568bc03: Connect multiple Slack workspaces to one GTM Grid workspace.

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

## 1.11.0

## 1.10.0

## 1.9.0

## 1.8.0

## 1.7.2

## 1.7.1

## 1.7.0

## 1.6.1

## 1.6.0

## 1.5.2

## 1.5.1

## 1.5.0

## 1.4.0

## 1.3.0

## 1.2.1

## 1.2.0

## 1.1.1

## 1.1.0

## 1.0.6

## 1.0.5

## 1.0.4

## 1.0.3

## 1.0.2

## 1.0.1

## 1.0.0

## 0.22.12

## 0.22.11

## 0.22.10

## 0.22.9

## 0.22.8

## 0.22.7

## 0.22.6

## 0.22.5

## 0.22.4

## 0.22.3

## 0.22.2

## 0.22.1

## 0.22.0

## 0.21.0

## 0.20.1

## 0.20.0

## 0.19.1

## 0.19.0

## 0.18.0

## 0.17.4

## 0.17.3

## 0.17.2

## 0.17.1

## 0.17.0

## 0.16.2

## 0.16.1

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.1

## 0.11.0

## 0.10.0

## 0.9.24

## 0.9.23

## 0.9.22

## 0.9.21

## 0.9.20

## 0.9.19

## 0.9.18

## 0.9.17

## 0.9.16

## 0.9.15

## 0.9.14

### Patch Changes

- 17ea929: Sidebar folders for tables, on both local and cloud projects: create, rename,
  and delete folders, file tables into them ("New table here" included), and
  drag to reorder. Deleting a folder unfiles its tables (never deletes them).
  Folder changes broadcast on the workspace room so teammates' sidebars update
  live. Cloud adds a `folders` table + `tables.folder_id` (migration 0009);
  local SQLite upgrades in place.

## 0.9.13

## 0.9.12

## 0.9.11

## 0.9.10

## 0.9.9

## 0.9.8

## 0.9.7

## 0.9.6

## 0.9.5

## 0.9.4

## 0.9.3

## 0.9.2

## 0.9.1

## 0.9.0

### Patch Changes

- a6d488d: Two cloud-parity improvements:
  - **Live sidebar** — when a teammate creates, syncs, or deletes a table in your
    workspace, your sidebar table list now updates in real time (no app restart).
    Table create/delete events are broadcast on a per-workspace realtime room that
    the sidebar subscribes to.
  - **Deduplication on cloud tables** — the Dedupe control (previously local-only)
    now works on cloud tables: pick a column and keep-oldest/newest, and the server
    removes duplicate rows and broadcasts the deletions live to everyone viewing the
    table. Adds a nullable `dedupe_column` / `dedupe_keep` to the cloud `tables`
    schema (migration included).

## 0.8.0

## 0.7.8

## 0.7.7

## 0.7.6

## 0.7.5

## 0.7.4

## 0.7.3

## 0.7.2

## 0.7.1

## 0.7.0

## 0.6.1

## 0.6.0

## 0.5.1

## 0.5.0

## 0.4.0

## 0.3.18

## 0.3.17

## 0.3.16

## 0.3.15

## 0.3.14

## 0.3.13

## 0.3.12

## 0.3.11

## 0.3.10

## 0.3.9

## 0.3.8

## 0.3.7

## 0.3.6

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0
