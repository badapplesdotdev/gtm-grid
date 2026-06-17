# @gtmgrid/engine

## 0.15.0

### Minor Changes

- f414614: Respect third-party API rate limits across all connectors. Every outbound connector call is now paced by a per-connector throttle (requests/second + max in-flight) at the engine's dispatch choke point, with researched limits baked into all bundled extensions and a conservative safety default (2 req/s, 2 concurrent) for any connector that declares none — so a large run can no longer fire an unbounded burst at a provider. Pure-local connectors (formatting/formula) are exempt.

  Transient failures (429/503/5xx and network blips) now retry with capped exponential backoff + jitter, honouring `Retry-After`: the manifest connector routes through the shared `fetchWithRetry`, the AI connector uses the vendor SDKs' own retry (maxRetries + timeout), and the cloud Trigify signal sync retries transient failures via an Effect schedule.

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.1

## 0.11.0

## 0.10.0

## 0.9.24

## 0.9.23

### Patch Changes

- 7c050a2: Make AI columns work without a separate AI key, and explain missing-key errors so
  the user can fix them.

  - **AI columns fall back to the agent's own model.** When no AI provider key is
    connected, `ai.generate` now routes the prompt through the user's already-
    authenticated coding agent (Claude Code / Codex) via a new `EngineConfig.aiFallback`
    (one agent call per row — slower than a batched key, but works with no key). Wired
    into every run path: the sidecar (in-process `generateWithAgent`), the MCP local +
    cloud engines (HTTP to the sidecar's new `POST /api/ai/generate`), and the cloud-run
    lane. This also fixes the cloud MCP path, which previously had **no** AI config at
    all (so `ai.generate` failed even when a key was connected).
  - **Run errors are surfaced to the agent.** `engine.runColumn` now returns the first
    cell error, and `run_column`/`run_table`/`run_function` attach an actionable
    `errorHint` — so a missing AI key, a 401, or a quota cap explains itself (and which
    panel fixes it) instead of the agent having to dig through `get_table`. The agent
    preamble is updated to relay these hints.

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

- c7bd3fc: Async-job connectors (e.g. Firecrawl extract) now block-poll until the job
  completes — with a wall-clock timeout and typed fail states — instead of
  returning a job id the grid can't use. Cells whose value carries an `error`
  field render an honest red error pill (with the real status code when one
  exists) instead of a fabricated "Status Code: 200".

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

## 0.8.0

## 0.7.8

### Patch Changes

- 6ab6cf9: Simplify integration credential scopes to **Local** and **Cloud**. The connector
  and AI-provider panels previously showed up to four confusing tabs (Workspace,
  Personal, Team, Local) where three of them all saved to the same machine. They now
  show just two:

  - **Local** — the key is stored on this machine only.
  - **Cloud** — the key is encrypted server-side and **shared with the whole team**
    (everyone in the workspace uses it). Shown only when signed into a cloud workspace.

  Pushing a local table to the cloud no longer fails when an integration is connected
  only locally: credentials are never synced, so a cloud run resolves the team's
  shared Cloud key (or surfaces a connect-integration error at run time if none is
  set). This also fixes the case where having both a local and a Cloud key wrongly
  blocked the push.

## 0.7.7

### Patch Changes

- c64cbf5: Fix two desktop bugs:

  - **In-app updater / notification popover was unclickable.** The transparent
    full-viewport `.popover-scrim` (z-index 100) sat _above_ the bell notification
    popover (z-index 61), so clicking "Update & restart" (or any action) hit the
    scrim and just closed the popover instead of firing the button. Raised the
    notification popover — and the dedupe popover, which had the same z-index 50 <
    scrim bug — above the scrim.

  - **Pushing a local table to the cloud dropped function-column config.** The
    local→cloud push only sent each column's name/type (and the sidecar hardcoded
    `kind: "manual"`), so a function/formula/code column landed in the cloud as a
    plain manual column and its cells could no longer be run/enriched. The push now
    carries the full config (kind/provider/method/code/params/condition); the
    `grid.addColumn` tRPC mutation also accepts `condition` so the "only run if"
    rule survives the push.

## 0.7.6

## 0.7.5

## 0.7.4

## 0.7.3

## 0.7.2

## 0.7.1

## 0.7.0

### Minor Changes

- accf1a9: Grid at scale: dedup + full agent control (bundles #53, #54, #55).

  - **Global-db credentials & extensions** (#53) — resolve credentials _and_
    extensions from the global db in `openProject`, fixing Exa/Firecrawl keys and
    the agent missing connectors (firecrawl/notion/supabase).
  - **HTTP request column** (#54) — generic HTTP request column (full request
    builder + try-on-N-rows) plus a LeadMagic 38-endpoint mapping.
  - **Agent session continuity** (#55) — resume the CLI's native session so chat
    survives Stop/restart, with stdin/transient-id fixes.
  - **Table deduplication** — Clay-style dedup: engine + `set_dedupe` agent tool +
    `add_rows` auto-dedup + a Deduplication panel in the table toolbar (toggle,
    column picker, keep oldest/newest, one-shot sweep).
  - **Full agent CRUD + safety** — `find_rows`, `get_column`, paginated
    `get_table` with row ids, `update_cells`/`update_column`/`rename_table`,
    `delete_rows`/`delete_column`/`delete_table`; destructive/large ops return a
    `{confirmationRequired, willAffect, estimatedCredits}` preview and require
    `confirm:true` to execute. `get_table` truncates large cell values to bound the
    agent's token budget.

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

## 0.2.0

## 0.1.0
