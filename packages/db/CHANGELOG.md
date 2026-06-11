# @gtmgrid/db

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
