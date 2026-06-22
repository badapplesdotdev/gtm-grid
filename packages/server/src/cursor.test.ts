// Unit tests for the Cursor (cursor-agent) bridge's pure helpers — the bits that
// don't require spawning a real `cursor-agent`: the MCP config we drop for it, and
// the tool-name normalization its stream-json events go through.

import { describe, expect, it } from "vitest";
import { mcpConfig, cursorToolShort } from "./agent.js";

describe("mcpConfig — gtmgrid-only server (what cursor's .cursor/mcp.json gets)", () => {
  it("emits a single gtmgrid MCP server with the launcher + project env", () => {
    const cfg = JSON.parse(mcpConfig("/repo", "proj"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["gtmgrid"]);
    expect(cfg.mcpServers.gtmgrid.env).toMatchObject({ GTMGRID_PROJECT: "proj" });
    // cursor-agent has no `--strict-mcp-config`; we still only register gtmgrid here.
    expect(cfg.mcpServers.gtmgrid.command).toContain("gtmgrid-mcp");
  });

  it("threads cloud context into the gtmgrid env when cloud is set", () => {
    const cloud = {
      apiUrl: "https://app.test",
      token: "secret-bearer",
      workspaceId: "ws_1",
      projectId: "proj_1",
      tableId: "tbl_1",
    };
    const cfg = JSON.parse(mcpConfig("/repo", "proj", undefined, cloud));
    expect(cfg.mcpServers.gtmgrid.env).toMatchObject({
      GTMGRID_MODE: "cloud",
      GTMGRID_CLOUD_TABLE: "tbl_1",
    });
  });
});

describe("cursorToolShort — normalize cursor's MCP tool names to the bare gtmgrid tool", () => {
  it("strips the double-underscore prefix (Anthropic-SDK style)", () => {
    expect(cursorToolShort("mcp__gtmgrid__add_rows")).toBe("add_rows");
  });

  it("strips the single-underscore prefix", () => {
    expect(cursorToolShort("mcp_gtmgrid_run_column")).toBe("run_column");
  });

  it("strips a bare gtmgrid_ / gtmgrid: prefix", () => {
    expect(cursorToolShort("gtmgrid_get_table")).toBe("get_table");
    expect(cursorToolShort("gtmgrid: delete_rows")).toBe("delete_rows");
  });

  it("leaves an already-bare tool name untouched", () => {
    expect(cursorToolShort("create_table")).toBe("create_table");
  });
});
