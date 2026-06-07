import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";

/**
 * These tests assert the AC for TRI-3243 at the schema level (no live DB):
 *   - all 12 cloud tables exist,
 *   - v.any() fields became jsonb,
 *   - every Convex index is recreated plus the new cells (table_id, column_id),
 *   - FK columns carry ON DELETE CASCADE.
 */

const grid = [
  schema.workspaces,
  schema.members,
  schema.invitations,
  schema.credentials,
  schema.projects,
  schema.tables,
  schema.columns,
  schema.rows,
  schema.cells,
  schema.extensions,
  schema.webhooks,
  schema.webhookDeliveries,
] as const;

describe("schema: all 12 cloud tables", () => {
  it("exposes the 12 Convex tables by their Postgres names", () => {
    const names = grid.map((t) => getTableConfig(t).name).sort();
    expect(names).toEqual(
      [
        "cells",
        "columns",
        "credentials",
        "extensions",
        "invitations",
        "members",
        "projects",
        "rows",
        "tables",
        "webhook_deliveries",
        "webhooks",
        "workspaces",
      ].sort(),
    );
  });
});

describe("schema: v.any() -> jsonb", () => {
  const jsonbCol = (table: (typeof grid)[number], col: string) => {
    const cfg = getTableConfig(table);
    const c = cfg.columns.find((x) => x.name === col);
    expect(c, `${cfg.name}.${col} should exist`).toBeDefined();
    return c?.getSQLType();
  };

  it("cells.value, columns.params, extensions.manifest are jsonb", () => {
    expect(jsonbCol(schema.cells, "value")).toBe("jsonb");
    expect(jsonbCol(schema.columns, "params")).toBe("jsonb");
    expect(jsonbCol(schema.extensions, "manifest")).toBe("jsonb");
  });
});

describe("schema: indexes recreated + new cells index", () => {
  const indexNames = (table: (typeof grid)[number]) =>
    getTableConfig(table).indexes.map((i) => i.config.name);

  it("recreates the cells indexes and adds (table_id, column_id)", () => {
    const names = indexNames(schema.cells);
    expect(names).toContain("cells_by_row");
    expect(names).toContain("cells_by_row_column");
    expect(names).toContain("cells_by_table");
    expect(names).toContain("cells_by_workspace");
    // The NEW index that did not exist in Convex.
    expect(names).toContain("cells_by_table_column");

    const newIdx = getTableConfig(schema.cells).indexes.find(
      (i) => i.config.name === "cells_by_table_column",
    );
    expect(newIdx?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      "table_id",
      "column_id",
    ]);
  });

  it("recreates members composite + invitations unique indexes", () => {
    expect(indexNames(schema.members)).toContain("members_by_workspace_user");
    expect(indexNames(schema.invitations)).toContain(
      "invitations_by_workspace_email",
    );
  });
});

describe("schema: FK cascade chain", () => {
  const fkTargets = (table: (typeof grid)[number]) =>
    getTableConfig(table).foreignKeys.map((fk) => ({
      onDelete: fk.onDelete,
      target: fk.reference().foreignTable,
    }));

  it("cells cascade-delete from workspace/table/row/column", () => {
    const fks = fkTargets(schema.cells);
    expect(fks.length).toBeGreaterThanOrEqual(4);
    // Every FK on cells cascades on delete (the grid teardown chain).
    expect(fks.every((fk) => fk.onDelete === "cascade")).toBe(true);
  });

  it("webhookDeliveries cascade from webhook (delivery log teardown)", () => {
    const fks = fkTargets(schema.webhookDeliveries);
    expect(fks.every((fk) => fk.onDelete === "cascade")).toBe(true);
  });
});
