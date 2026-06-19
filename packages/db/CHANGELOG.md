# @gtmgrid/db

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
