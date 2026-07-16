/**
 * Permission-mode policy + human-in-the-loop (HITL) approval for the gtmgrid MCP
 * tools — the ONE layer all three agent providers (claude/codex/cursor) share, so
 * the 4 composer modes are enforced uniformly regardless of provider.
 *
 * The four modes and how they gate a GRID tool (there are no file edits, so tools
 * are bucketed by RISK CLASS):
 *
 *   class \ mode   | bypass  | auto    | acceptEdits | plan
 *   ---------------|---------|---------|-------------|------
 *   read           | execute | execute | execute     | execute
 *   edit           | execute | execute | execute     | block
 *   destructive    | execute | confirm | confirm     | block
 *   spend (free)   | execute | execute | execute     | block
 *   spend ≤thr     | execute | execute | confirm     | block
 *   spend >thr     | execute | confirm | confirm     | block
 *
 * ENFORCEMENT (defeats model self-confirm): when a tool needs confirmation it
 * returns `confirmationRequired` and does NOT execute. The model cannot unlock it
 * by setting `confirm:true` — only a HUMAN approval does. The approval travels
 * server→env (`GTMGRID_APPROVED_TOOL`/`GTMGRID_APPROVED_ARGS_HASH`, set on the
 * resumed turn after the user clicks Approve), a channel the model cannot reach
 * (it only controls tool args). The {@link hashArgs} binding means an approval is
 * good for exactly the action the user saw — not a different tool or different args.
 */
import { createHash } from "node:crypto";

export type PermissionMode = "bypassPermissions" | "auto" | "acceptEdits" | "plan";
export type RiskClass = "read" | "edit" | "destructive" | "spend";
export type Decision = "execute" | "confirm" | "block";

const MODES = new Set<PermissionMode>([
  "bypassPermissions",
  "auto",
  "acceptEdits",
  "plan",
]);

/** The composer permission mode for this MCP process; absent ⇒ legacy bypass. */
export function parsePermissionMode(
  env: Record<string, string | undefined>,
): PermissionMode {
  const m = env.GTMGRID_PERMISSION_MODE;
  return m && MODES.has(m as PermissionMode)
    ? (m as PermissionMode)
    : "bypassPermissions";
}

/** Whether the spawning launcher wired the permission system (vs an old client). */
export function permissionConfigured(
  env: Record<string, string | undefined>,
): boolean {
  return typeof env.GTMGRID_PERMISSION_MODE === "string";
}

/**
 * Per-tool risk class. Anything not listed is treated as `read` (safe — never
 * gated), so adding a new read tool needs no change here. Mutating tools MUST be
 * listed so a stricter mode gates them.
 */
export const RISK_CLASS: Record<string, RiskClass> = {
  // edits — create/modify structure or data, no credit spend, non-destructive
  create_table: "edit",
  rename_table: "edit",
  add_column: "edit",
  update_column: "edit",
  add_rows: "edit",
  update_cells: "edit",
  set_dedupe: "edit",
  reorder_columns: "edit",
  reorder_rows: "edit",
  upload_extension: "edit",
  import_table_from_share: "edit",
  create_pipeline: "edit",
  patch_pipeline: "edit",
  // destructive — irreversible data loss
  delete_rows: "destructive",
  delete_column: "destructive",
  delete_table: "destructive",
  // spend — may cost credits (gated only when credits > 0)
  run_column: "spend",
  run_table: "spend",
  run_function: "spend",
  deploy_pipeline: "destructive",
};

export function riskClass(tool: string): RiskClass {
  return RISK_CLASS[tool] ?? "read";
}

/**
 * Decide whether a tool may run under `mode`. `affected` (rows/cells touched) and
 * `credits` (per the resolved method) feed the threshold so large/expensive ops
 * still ask even in modes that auto-run small ones. Pure + exhaustively tested.
 */
export function decide(
  mode: PermissionMode,
  cls: RiskClass,
  opts?: { affected?: number; credits?: number; threshold?: number },
): Decision {
  if (cls === "read") return "execute";
  if (mode === "bypassPermissions") return "execute";
  if (mode === "plan") return "block";
  // auto | acceptEdits from here.
  const affected = opts?.affected ?? 0;
  const credits = opts?.credits ?? 0;
  const threshold = opts?.threshold ?? 50;
  const large = affected > threshold;
  if (cls === "edit") {
    // Edits run freely in auto + acceptEdits; only an outsized bulk edit asks.
    return large ? "confirm" : "execute";
  }
  if (cls === "destructive") return "confirm";
  // spend
  if (credits <= 0) return "execute"; // free helper (formatting / user-key ai.generate)
  if (mode === "acceptEdits") return "confirm"; // every paid run asks
  return large ? "confirm" : "execute"; // auto: small paid runs go, large ones ask
}

/**
 * Canonical hash of a tool's gated input args (sorted keys; the `confirm` flag is
 * excluded since it's not part of the action) so a human approval binds to the
 * EXACT action they saw. The model re-calling with the same args reproduces the
 * hash; changing the args (e.g. a wider `where`) produces a different hash and
 * stays gated.
 */
export function hashArgs(args: Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...args };
  delete rest.confirm;
  return createHash("sha256").update(canonical(rest)).digest("hex").slice(0, 32);
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export interface ApprovedAction {
  readonly tool: string;
  readonly argsHash: string;
}

/**
 * The human-approved action threaded into the MCP env on a resumed turn (set by
 * the chat route after the user clicks Approve), or undefined on a normal turn.
 */
export function parseApprovedAction(
  env: Record<string, string | undefined>,
): ApprovedAction | undefined {
  const tool = env.GTMGRID_APPROVED_TOOL;
  const argsHash = env.GTMGRID_APPROVED_ARGS_HASH;
  return tool && argsHash ? { tool, argsHash } : undefined;
}
