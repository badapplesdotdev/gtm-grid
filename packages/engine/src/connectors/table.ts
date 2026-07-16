// Built-in "Tables" connector — cross-table actions within the SAME project:
//
//   table.push    Write this row's mapped data into another table, upserting by
//                 a key column (Clay's "Write to Other Table" + dedupe key).
//   table.lookup  Find row(s) in another table by matching a value and return
//                 their columns (Clay's "Lookup Single Row in Other Table").
//
// Both run through the injected TableGateway (`ctx.grid`) — the one narrow
// cross-table door — whose backing worker routes enforce same-project scoping
// server-side. Every string input supports {{Column}} templating, including
// values nested inside the push `mapping` object (resolveParams interpolates
// deep). These methods let a pipeline JOIN tables instead of multiplying them:
// route qualified rows to a shared table, or pull a sibling table's data in.

import type { TableGateway, GatewayTableSchema } from "../table-gateway.js";
import type { Connector, ConnectorMethod, MethodContext } from "../types.js";

/** The gateway, or a clear error on hosts that don't wire cross-table access. */
function requireGrid(ctx: MethodContext, method: string): TableGateway {
  if (!ctx.grid) {
    throw new Error(
      `table.${method}: cross-table access is not available here. Run this as a column on a table (or through a run path that provides table access).`,
    );
  }
  return ctx.grid;
}

/** Resolve the target table by id or exact name, with a human error when gone. */
async function requireSchema(
  grid: TableGateway,
  method: string,
  targetRef: unknown,
): Promise<GatewayTableSchema> {
  const ref = typeof targetRef === "string" ? targetRef.trim() : "";
  if (!ref) throw new Error(`table.${method}: 'targetTable' is required`);
  const schema = await grid.getSchema(ref);
  if (!schema) {
    throw new Error(
      `table.${method}: target table ${JSON.stringify(ref)} not found — was it renamed or deleted? Pick the table again in the column settings.`,
    );
  }
  return schema;
}

/**
 * Canonicalize a cell value for match comparison: strings are trimmed (and
 * lowercased when case-insensitive), numbers/booleans compare by their string
 * form (so a CSV-imported "42" matches a numeric 42), objects/arrays by JSON.
 * Null/undefined canonicalize to null and NEVER match (an empty probe must not
 * match rows whose key cell is empty).
 */
function canon(v: unknown, caseInsensitive: boolean): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return null;
    return caseInsensitive ? s.toLowerCase() : s;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

const push: ConnectorMethod = {
  id: "push",
  label: "Push to table",
  description:
    "Send this ROW into ANOTHER table in the project. The whole row is delivered like an inbound webhook record: the raw data lands in the target's 'Pushed data' column, MANUAL target columns whose names match the source's fill AUTOMATICALLY, and the TARGET table's field mapping (edit it there, like a webhook's) routes everything else — map to existing columns or create new ones, and backfill rows already pushed. In 'upsert' mode (default) rows are deduplicated on a key column — the first run inserts, re-runs update the matched row, so running twice never duplicates. 'append' always adds a new row. Use this to route qualified rows into a shared/master table instead of creating a new table per step. Returns { rowId, action: 'created'|'updated' }.",
  category: "Tables",
  batchSize: 1,
  credits: 0,
  output: "json",
  inputSchema: {
    type: "object",
    required: ["targetTable"],
    properties: {
      targetTable: {
        type: "string",
        description: "The target table's id (preferred) or exact name. Must be in this project.",
      },
      mode: {
        type: "string",
        enum: ["upsert", "append"],
        description:
          "upsert (default): match an existing row on keyColumn/keyValue and update it, inserting only when no match. append: always insert a new row (re-runs will duplicate).",
      },
      keyColumn: {
        type: "string",
        description:
          "Target column NAME to deduplicate on (e.g. 'Email'). Required for upsert mode.",
      },
      keyValue: {
        type: "string",
        description:
          "The value to match, usually a template like {{Email}}. Required for upsert mode; a row whose key resolves empty errors instead of inserting a keyless duplicate.",
      },
      autoRunTarget: {
        type: "boolean",
        description:
          "After the push, run the target table's function columns over the touched row (its own cross-table push columns are skipped to prevent loops). Default false.",
      },
    },
  },
  run: async (input: Record<string, unknown>, ctx: MethodContext): Promise<unknown> => {
    const grid = requireGrid(ctx, "push");
    if (!ctx.row) {
      throw new Error(
        "table.push: no source row in context — run this as a column on a table (it delivers the current row).",
      );
    }
    const schema = await requireSchema(grid, "push", input.targetTable);

    if (
      (grid.sourceTableId !== undefined && grid.sourceTableId === schema.id) ||
      ctx.row.tableId === schema.id
    ) {
      throw new Error(
        "table.push: a column cannot push into its own table — pick a different target table.",
      );
    }

    const mode = input.mode === "append" ? "append" : "upsert";

    // Resolve + validate the dedupe key sender-side for a human error message
    // (the server re-validates authoritatively).
    let keyColumnName: string | null = null;
    let keyValue: unknown = null;
    if (mode === "upsert") {
      const keyName = typeof input.keyColumn === "string" ? input.keyColumn.trim() : "";
      if (!keyName) throw new Error("table.push: upsert mode requires 'keyColumn' (the target column to deduplicate on)");
      const keyCol = schema.columns.find((c) => c.name === keyName);
      if (!keyCol) {
        throw new Error(
          `table.push: key column ${JSON.stringify(keyName)} does not exist in "${schema.name}"`,
        );
      }
      if (keyCol.kind !== "manual") {
        throw new Error(
          `table.push: key column ${JSON.stringify(keyName)} is a function column in "${schema.name}" — dedupe on a manual column.`,
        );
      }
      keyColumnName = keyName;
      keyValue = input.keyValue;
      if (canon(keyValue, false) === null) {
        throw new Error(
          "table.push: the upsert key resolved empty for this row — refusing to insert a keyless duplicate. Fill the key column or switch to append mode.",
        );
      }
    }

    const result = await grid.pushRow({
      tableId: schema.id,
      sourceRowId: ctx.row.rowId,
      // The push column itself is excluded from the delivered payload — its
      // own result cell is provenance, not data the target should receive.
      sourceColumnId: ctx.row.columnId,
      mode,
      keyColumnName,
      keyValue,
      autoRunTarget: input.autoRunTarget === true,
    });

    return {
      table: schema.name,
      tableId: schema.id,
      rowId: result.rowId,
      action: result.created ? "created" : "updated",
    };
  },
};

const lookup: ConnectorMethod = {
  id: "lookup",
  label: "Lookup table",
  description:
    "Find a row in ANOTHER table in the project by matching a value against one of its columns, and return that row's data (like Clay's 'Lookup Single Row in Other Table'). Use {{Column}} templates for the match value, e.g. match {{Email}} against the other table's Email column. Returns the matched row's columns as an object (drill in to map fields into columns), or all matches / a count. Use this to JOIN data across tables instead of re-enriching or duplicating it.",
  category: "Tables",
  batchSize: 1,
  credits: 0,
  output: "json",
  inputSchema: {
    type: "object",
    required: ["targetTable", "matchColumn", "matchValue"],
    properties: {
      targetTable: {
        type: "string",
        description: "The table to look up in — its id (preferred) or exact name. Must be in this project.",
      },
      matchColumn: {
        type: "string",
        description: "The target column NAME to match against, e.g. 'Email'.",
      },
      matchValue: {
        type: "string",
        description: "The value to find, usually a template like {{Email}}. An empty value matches nothing.",
      },
      return: {
        type: "array",
        items: { type: "string" },
        description: "Target column names to return. Omit or empty for ALL columns.",
      },
      multiple: {
        type: "string",
        enum: ["first", "all", "count"],
        description:
          "When several rows match: first (default) returns the first by row order, all returns an array of every match, count returns the number of matches.",
      },
      caseInsensitive: {
        type: "boolean",
        description: "Match strings ignoring case (values are always trimmed). Default false.",
      },
      notFound: {
        type: "string",
        enum: ["null", "error"],
        description:
          "When nothing matches: null (default) returns null so downstream conditions can gate on it; error marks the cell as an error.",
      },
    },
  },
  run: async (input: Record<string, unknown>, ctx: MethodContext): Promise<unknown> => {
    const grid = requireGrid(ctx, "lookup");
    const schema = await requireSchema(grid, "lookup", input.targetTable);

    const matchName = typeof input.matchColumn === "string" ? input.matchColumn.trim() : "";
    if (!matchName) throw new Error("table.lookup: 'matchColumn' is required");
    if (!schema.columns.some((c) => c.name === matchName)) {
      throw new Error(
        `table.lookup: match column ${JSON.stringify(matchName)} does not exist in "${schema.name}"`,
      );
    }

    const multiple = input.multiple === "all" || input.multiple === "count" ? input.multiple : "first";
    const caseInsensitive = input.caseInsensitive === true;
    const onMiss = (): unknown => {
      if (input.notFound === "error") {
        throw new Error(
          `table.lookup: no row in "${schema.name}" matched ${JSON.stringify(matchName)} = ${JSON.stringify(input.matchValue)}`,
        );
      }
      return multiple === "all" ? [] : multiple === "count" ? 0 : null;
    };

    const probe = canon(input.matchValue, caseInsensitive);
    if (probe === null) return onMiss(); // empty probe never matches empty cells

    const rows = await grid.readRows(schema.id);
    const matches = rows.filter((r) => canon(r.cells[matchName], caseInsensitive) === probe);
    if (matches.length === 0) return onMiss();
    if (multiple === "count") return matches.length;

    const wanted =
      Array.isArray(input.return) && input.return.length > 0
        ? input.return.filter((n): n is string => typeof n === "string")
        : schema.columns.map((c) => c.name);
    const pick = (row: { rowId: string; cells: Record<string, unknown> }): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const name of wanted) out[name] = row.cells[name] ?? null;
      out._rowId = row.rowId;
      return out;
    };

    return multiple === "all" ? matches.map(pick) : pick(matches[0]);
  },
};

export const tableConnector: Connector = {
  id: "table",
  name: "Tables",
  category: "tables",
  auth: null,
  // The gateway talks to our own worker API (quota-gated server-side), not a
  // third-party service — exempt it from the default outbound throttle.
  local: true,
  methods: [push, lookup],
};
