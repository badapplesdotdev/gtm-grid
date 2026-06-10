# @gtmgrid/mcp

## 0.7.3

### Patch Changes

- @gtmgrid/engine@0.7.3

## 0.7.2

### Patch Changes

- @gtmgrid/engine@0.7.2

## 0.7.1

### Patch Changes

- @gtmgrid/engine@0.7.1

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

### Patch Changes

- Updated dependencies [accf1a9]
  - @gtmgrid/engine@0.7.0

## 0.6.1

### Patch Changes

- @gtmgrid/engine@0.6.1

## 0.6.0

### Patch Changes

- @gtmgrid/engine@0.6.0

## 0.5.1

### Patch Changes

- @gtmgrid/engine@0.5.1

## 0.5.0

### Patch Changes

- @gtmgrid/engine@0.5.0

## 0.4.0

### Patch Changes

- @gtmgrid/engine@0.4.0

## 0.3.18

### Patch Changes

- @gtmgrid/engine@0.3.18

## 0.3.17

### Patch Changes

- @gtmgrid/engine@0.3.17

## 0.3.16

### Patch Changes

- @gtmgrid/engine@0.3.16

## 0.3.15

### Patch Changes

- @gtmgrid/engine@0.3.15

## 0.3.14

### Patch Changes

- @gtmgrid/engine@0.3.14

## 0.3.13

### Patch Changes

- @gtmgrid/engine@0.3.13

## 0.3.12

### Patch Changes

- @gtmgrid/engine@0.3.12

## 0.3.11

### Patch Changes

- @gtmgrid/engine@0.3.11

## 0.3.10

### Patch Changes

- @gtmgrid/engine@0.3.10

## 0.3.9

### Patch Changes

- @gtmgrid/engine@0.3.9

## 0.3.8

### Patch Changes

- @gtmgrid/engine@0.3.8

## 0.3.7

### Patch Changes

- @gtmgrid/engine@0.3.7

## 0.3.6

### Patch Changes

- @gtmgrid/engine@0.3.6

## 0.3.5

### Patch Changes

- @gtmgrid/engine@0.3.5

## 0.3.4

### Patch Changes

- @gtmgrid/engine@0.3.4

## 0.3.3

### Patch Changes

- @gtmgrid/engine@0.3.3

## 0.3.2

### Patch Changes

- @gtmgrid/engine@0.3.2

## 0.3.1

### Patch Changes

- @gtmgrid/engine@0.3.1

## 0.3.0

### Patch Changes

- @gtmgrid/engine@0.3.0

## 0.2.0

### Patch Changes

- @gtmgrid/engine@0.2.0

## 0.1.0

### Patch Changes

- @gtmgrid/engine@0.1.0
