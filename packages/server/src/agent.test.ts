import { describe, expect, it } from "vitest";
import { codexEnvToml, mcpEnv, parseAgentCloud, type AgentCloud } from "./agent.js";

const CLOUD: AgentCloud = {
  apiUrl: "https://app.test",
  token: "secret-bearer",
  workspaceId: "ws_1",
  projectId: "proj_1",
  tableId: "tbl_1",
};

describe("parseAgentCloud — validate the chat body's cloud block (TRI-3296)", () => {
  it("parses a complete block", () => {
    expect(parseAgentCloud({ ...CLOUD })).toEqual(CLOUD);
  });

  it("trims values", () => {
    expect(parseAgentCloud({ ...CLOUD, apiUrl: "  https://app.test  " })?.apiUrl).toBe(
      "https://app.test",
    );
  });

  it("returns undefined for a missing/blank field (no half-activation)", () => {
    expect(parseAgentCloud({ ...CLOUD, token: "" })).toBeUndefined();
    expect(parseAgentCloud({ ...CLOUD, tableId: undefined })).toBeUndefined();
  });

  it("returns undefined for non-object / absent input (local mode)", () => {
    expect(parseAgentCloud(undefined)).toBeUndefined();
    expect(parseAgentCloud(null)).toBeUndefined();
    expect(parseAgentCloud("nope")).toBeUndefined();
  });
});

describe("mcpEnv — the env the spawned MCP receives (data-source selection)", () => {
  it("LOCAL: only GTMGRID_PROJECT, byte-identical to before", () => {
    expect(mcpEnv("my-project")).toEqual({ GTMGRID_PROJECT: "my-project" });
  });

  it("CLOUD: threads mode + apiUrl/token/workspace/project/table", () => {
    expect(mcpEnv("my-project", CLOUD)).toEqual({
      GTMGRID_PROJECT: "my-project",
      GTMGRID_MODE: "cloud",
      GTMGRID_API_URL: "https://app.test",
      GTMGRID_TOKEN: "secret-bearer",
      GTMGRID_WORKSPACE_ID: "ws_1",
      GTMGRID_CLOUD_PROJECT: "proj_1",
      GTMGRID_CLOUD_TABLE: "tbl_1",
    });
  });
});

describe("codexEnvToml — safe inline-TOML rendering for the codex -c flag", () => {
  it("renders the local env as a quoted TOML table", () => {
    expect(codexEnvToml(mcpEnv("p"))).toBe('{ GTMGRID_PROJECT = "p" }');
  });

  it("escapes double-quotes and backslashes in a value so a token cannot break out", () => {
    const toml = codexEnvToml({ GTMGRID_TOKEN: 'a"b\\c' });
    expect(toml).toBe('{ GTMGRID_TOKEN = "a\\"b\\\\c" }');
  });

  it("renders every cloud field", () => {
    const toml = codexEnvToml(mcpEnv("p", CLOUD));
    expect(toml).toContain('GTMGRID_MODE = "cloud"');
    expect(toml).toContain('GTMGRID_CLOUD_TABLE = "tbl_1"');
  });
});
