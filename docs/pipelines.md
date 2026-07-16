# Pipelines

Pipelines are reusable, versioned record automations that can be attached to a table. They complement columns; they do not replace them.

## Product choice

- Use one function column for one independent enrichment or transform.
- Use dependent columns for a visible, linear, table-specific sequence.
- Use a pipeline for reuse across tables, branching, multiple outputs, remote triggers, or an independent deploy/version lifecycle.

The desktop exposes pipelines in the project sidebar and from a table's **Automate** action. Both entry points open the same pipeline entity and editor; attaching from a table adds a mapping step rather than creating a second kind of automation.

## Authoring and deployment

Graphs are strict V1 DAGs. The shared `@gtmgrid/pipelines` package owns the schema, validation, atomic patch operations, compiler, action estimate, batch planner, and record runner.

- Draft versions are mutable through validated atomic patches.
- Deployment validates and freezes a version.
- Existing runs and bindings remain pinned to their immutable version.
- Editing a deployed pipeline clones a new draft.
- Inputs and outputs are structural nodes and cost no actions.
- Tool, AI, formula, HTTP, code, condition, and sub-pipeline nodes are executable nodes.

The canvas is intentionally a focused table-automation editor: node tray on the left, graph in the centre, configuration/AI/history rail on the right, and a trace console below. It is not a general-purpose integration product embedded wholesale.

## Local and cloud execution

The record runner is runtime-independent. A target-specific node executor supplies connector calls, AI, HTTP, and sandbox execution.

- **Local target:** computation is owned by the desktop sidecar and may use personal/local credentials and the connected coding-agent AI fallback. Table data remains cloud-backed. The app must stay online.
- **Cloud target:** the tRPC run mutation creates a durable run and sends `pipeline/run.requested` to Inngest. Cloud execution uses workspace-shared credentials only; it never uses a member's personal secret or local coding-agent fallback.

Inngest is the durable shell, while graph semantics stay in the shared runner:

1. Start the pinned run.
2. Page table rows by a stable keyset cursor.
3. Persist one bounded batch (default 250 rows).
4. Emit one event per batch, never one event per row.
5. Execute each record with per-row Inngest step memoization.
6. Commit mapped outputs and record row/node history.
7. Complete the run when persisted processed records reach the final planned total.

A one-million-record run creates 4,000 bounded 250-row batches. No coordinator or worker loads the full table into memory.

## Credentials and security

- Bindings and runs must match workspace, pipeline, deployed version, table, and execution target.
- Cloud connector calls resolve only workspace-scoped encrypted credentials through the secret-gated worker boundary.
- Cloud AI loads workspace credentials named `ai:anthropic`, `ai:openai`, `ai:openrouter`, or `ai:hermes`; deployment does not copy secrets into a graph.
- HTTP execution enables the existing SSRF guard on shared infrastructure.
- Code and formulas execute in the existing QuickJS sandbox with a connector allow-list, time limit, and memory limit.
- Pipeline output writes verify the row and every output column belong to the bound workspace/table.

## Actions and idempotency

One executable cloud node starting for one record costs one action. Structural nodes, skipped branches, local execution, and the final output cell write cost zero additional actions.

The receipt key is `runId:rowId:nodeId:generation`. The action ledger has a unique constraint on that key, and the workspace counter plus run counter are updated in the same transaction. An Inngest retry therefore cannot charge the same node twice. Row results and batches have equivalent run-scoped unique keys.

Before a large run, the UI should show minimum, expected, and maximum actions from the compiled plan. The maximum is the safe confirmation figure; the consumed count is the exact figure shown in history.

## AI controls

The sidecart has narrow tools to list, inspect, create, atomically patch, and deploy pipelines. Its system policy explicitly selects columns for simple work and pipelines only for the product cases above.

- The model reads the current graph before editing.
- Patches are server-validated and affect the draft only.
- The visual graph is the review surface.
- Deployment is classified as a production/destructive operation and requires human approval.
- The model must state the maximum action estimate before proposing a large run.

## Operations and retention

`pipeline_runs` stores live counters for cheap progress reads. Batches, row outcomes, and compact node receipts provide drill-down without putting verbose payloads on the hot run row. The desktop polls only while a run is active.

Completed execution history is retained for 30 days. A daily Inngest cleanup deletes expired terminal `pipeline_runs` in bounded batches; foreign-key cascades remove their batches, row/node logs, action receipts, and reservations. Active runs are never deleted by retention. Structured results written into table pipeline-output cells are user data rather than execution logs and are retained until overwritten or deleted by the user.

Node logging is deliberately de-duplicated: the complete incoming record is stored once on the trigger node, each executed node stores only its own native output, and downstream inputs are reconstructed from graph edges when Logs are read. Strings, numbers, and booleans remain native scalar values; JSON is used only for actual objects/arrays. Any individual log value above 64 KiB is replaced by a bounded preview receipt containing its type, byte size, and SHA-256 hash. This limit affects execution logs only, never the table result.

Verbose input/output traces should be moved to object storage behind `traceRef` with redaction and a retention policy before enabling full payload capture in production. The relational node history deliberately stores status, timing, error, and action receipt only.

## Release gates

- Apply migration `0017_quick_gorilla_man.sql` before enabling the feature.
- Keep creation and execution behind separate feature flags during rollout.
- Start with manual runs and a conservative workspace concurrency limit.
- Add schedule/webhook trigger enablement only after run cancellation, stale-run recovery, reservation reconciliation, and operational alerts are deployed.
- Load-test cursor planning, worker throughput, provider rate limiting, history reads, and action-ledger contention at one million records before raising limits.
