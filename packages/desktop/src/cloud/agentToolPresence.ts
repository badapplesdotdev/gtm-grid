/**
 * Pure mapping from an agent tool call (the sidecar's SSE `{type:"tool", name,
 * input}` events) to the presence patch the agent should publish — which cell
 * ring / column-header ring / activity label the grid shows while the agent
 * works. React-free and side-effect-free so the mapping is unit-testable.
 *
 * Tool names/args mirror the gtmgrid MCP server (packages/mcp/src/index.ts):
 * `table`/`column` are NAMES (resolved to ids against the OPEN table here);
 * row ids in `update_cells`/`delete_rows` are real row `_id`s. Tools that
 * target a different table than the one open in the grid map to `null` — the
 * presence room is per-table, so there is nothing to decorate.
 */

import type { GridPresenceCell } from "@gtmgrid/services/realtime";

/** What one tool call means for the agent's presence (all-or-nothing replace). */
export interface AgentPresencePatch {
  /** Cell the agent is selected on (ring), if cell-precise. */
  readonly cursor: GridPresenceCell | null;
  /** Cell the agent is writing (stronger pulsing ring), if known. */
  readonly editing: GridPresenceCell | null;
  /** Column the agent is working over (column-header ring), if column-scoped. */
  readonly column: string | null;
  /** Human-readable label, e.g. "adding 5 rows". */
  readonly activity: string;
}

/** The open table's identity the mapper resolves names against. */
export interface AgentPresenceTableContext {
  /** The open table's display name (tool args carry table NAMES). */
  readonly tableName: string;
  /** Column display name (lower-cased) → columnId for the open table. */
  readonly columnIdByName: ReadonlyMap<string, string>;
}

/** A tool event as forwarded from the agent SSE stream. */
export interface AgentToolEvent {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

const sameTable = (input: Record<string, unknown>, ctx: AgentPresenceTableContext): boolean => {
  const table = str(input.table);
  return table !== null && table.trim().toLowerCase() === ctx.tableName.trim().toLowerCase();
};

const resolveColumn = (name: unknown, ctx: AgentPresenceTableContext): string | null => {
  const n = str(name);
  return n === null ? null : (ctx.columnIdByName.get(n.trim().toLowerCase()) ?? null);
};

const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

const none = { cursor: null, editing: null, column: null } as const;

/**
 * Map one tool call to the agent presence patch, or `null` when the call says
 * nothing about THIS table (different/absent table arg on a table-scoped tool,
 * or a non-grid tool like `search_functions`). A `null` means "keep showing
 * whatever the agent was last doing" — the controller only clears on turn end.
 */
export function mapToolToPresence(
  ev: AgentToolEvent,
  ctx: AgentPresenceTableContext,
): AgentPresencePatch | null {
  const input = ev.input ?? {};
  switch (ev.name) {
    // ── Table-scoped reads ──
    case "get_table":
      return sameTable(input, ctx) ? { ...none, activity: "reading the table" } : null;
    case "find_rows":
      return sameTable(input, ctx) ? { ...none, activity: "searching rows" } : null;
    case "get_column":
    case "describe_column": {
      if (!sameTable(input, ctx)) return null;
      const columnId = resolveColumn(input.column, ctx);
      const label = str(input.column);
      return { ...none, column: columnId, activity: label === null ? "reading a column" : `reading ${label}` };
    }

    // ── Table-scoped writes ──
    case "add_rows": {
      if (!sameTable(input, ctx)) return null;
      const n = count(input.rows);
      return { ...none, activity: n > 0 ? `adding ${plural(n, "row")}` : "adding rows" };
    }
    case "update_cells": {
      if (!sameTable(input, ctx)) return null;
      const updates = Array.isArray(input.updates) ? input.updates : [];
      const first = updates[0] as { row?: unknown; column?: unknown } | undefined;
      const rowId = str(first?.row);
      const columnId = resolveColumn(first?.column, ctx);
      const editing = rowId !== null && columnId !== null ? { rowId, columnId } : null;
      return {
        cursor: editing,
        editing,
        column: editing === null ? columnId : null,
        activity: `updating ${plural(updates.length, "cell")}`,
      };
    }
    case "delete_rows":
      return sameTable(input, ctx) ? { ...none, activity: "deleting rows" } : null;
    case "run_column": {
      if (!sameTable(input, ctx)) return null;
      const label = str(input.column);
      return {
        ...none,
        column: resolveColumn(input.column, ctx),
        activity: label === null ? "running a column" : `running ${label}`,
      };
    }
    case "add_column": {
      if (!sameTable(input, ctx)) return null;
      const label = str(input.name);
      return { ...none, activity: label === null ? "adding a column" : `adding column ${label}` };
    }
    case "update_column":
    case "delete_column": {
      if (!sameTable(input, ctx)) return null;
      const verb = ev.name === "delete_column" ? "removing" : "editing";
      const label = str(input.column);
      return {
        ...none,
        column: resolveColumn(input.column, ctx),
        activity: label === null ? `${verb} a column` : `${verb} ${label}`,
      };
    }

    // ── Workspace-scoped (no table arg to match) ──
    case "list_tables":
      return { ...none, activity: "browsing tables" };
    case "create_table":
      return { ...none, activity: "creating a table" };

    default:
      return null;
  }
}
