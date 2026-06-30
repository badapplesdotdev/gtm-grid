// Coverage for the cross-platform MCP launch wiring (the Windows-only fix where
// the grid tools — get_table / add_rows / run_function / list_providers — never
// loaded because the agent CLI was pointed at an extensionless `#!/bin/bash`
// launcher Windows cannot execute). The fix spawns the bundled `node` directly
// with `mcp.mjs` as a script arg, which every MCP client launches identically on
// macOS, Linux and Windows.
//
// These helpers read process.env at call time, so each test sets/clears the
// GTMGRID_MCP_* vars itself and a beforeEach wipes them for a deterministic base.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexEnvToml,
  mcpConfig,
  mcpEnv,
  mcpLaunch,
  tomlString,
  tomlStringArray,
} from "./agent.js";

const MCP_VARS = ["GTMGRID_MCP_NODE", "GTMGRID_MCP_SCRIPT", "GTMGRID_MCP_LAUNCHER"] as const;

function clearMcpVars() {
  for (const k of MCP_VARS) delete process.env[k];
}

describe("mcpLaunch — how the gtmgrid MCP server is spawned for an agent CLI", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of MCP_VARS) saved[k] = process.env[k];
    clearMcpVars();
  });
  afterEach(() => {
    for (const k of MCP_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("PACKAGED: spawns the bundled node directly with mcp.mjs as a script arg", () => {
    process.env.GTMGRID_MCP_NODE = "/Applications/GTM Grid.app/sidecar/node";
    process.env.GTMGRID_MCP_SCRIPT = "/Applications/GTM Grid.app/sidecar/mcp.mjs";
    expect(mcpLaunch("/ignored")).toEqual({
      command: "/Applications/GTM Grid.app/sidecar/node",
      args: ["/Applications/GTM Grid.app/sidecar/mcp.mjs"],
    });
  });

  it("PACKAGED on Windows: keeps the plain (de-verbatim'd) node.exe + mcp.mjs paths", () => {
    // The Rust shell already strips the `\\?\` prefix via dunce::simplified, so we
    // receive a plain `C:\…` path here. Crucially this is NOT a `.cmd`/bash shim.
    process.env.GTMGRID_MCP_NODE = "C:\\Users\\Donut\\AppData\\Local\\GTM Grid\\sidecar\\node.exe";
    process.env.GTMGRID_MCP_SCRIPT = "C:\\Users\\Donut\\AppData\\Local\\GTM Grid\\sidecar\\mcp.mjs";
    const { command, args } = mcpLaunch("C:\\repo");
    expect(command).toBe("C:\\Users\\Donut\\AppData\\Local\\GTM Grid\\sidecar\\node.exe");
    expect(command.endsWith("node.exe")).toBe(true);
    expect(args).toEqual(["C:\\Users\\Donut\\AppData\\Local\\GTM Grid\\sidecar\\mcp.mjs"]);
  });

  it("DEV: runs the TS entry through tsx with the running node", () => {
    const { command, args } = mcpLaunch("/repo");
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe("--import");
    expect(args[1]).toBe("tsx");
    // Last arg is the absolute MCP entry under the given repo root.
    expect(args[2]).toContain("packages");
    expect(args[2]).toContain("mcp");
    expect(args[2].endsWith("index.ts")).toBe(true);
    expect(args[2].startsWith("/repo")).toBe(true);
  });

  it("LEGACY: an explicit GTMGRID_MCP_LAUNCHER is honoured with empty args", () => {
    process.env.GTMGRID_MCP_LAUNCHER = "/opt/custom/gtmgrid-mcp";
    expect(mcpLaunch("/repo")).toEqual({ command: "/opt/custom/gtmgrid-mcp", args: [] });
  });

  it("PRECEDENCE: node+script wins over a stale legacy launcher", () => {
    process.env.GTMGRID_MCP_NODE = "/s/node";
    process.env.GTMGRID_MCP_SCRIPT = "/s/mcp.mjs";
    process.env.GTMGRID_MCP_LAUNCHER = "/old/gtmgrid-mcp";
    expect(mcpLaunch("/repo")).toEqual({ command: "/s/node", args: ["/s/mcp.mjs"] });
  });

  it("falls back to dev when only one of node/script is present (never half-configured)", () => {
    process.env.GTMGRID_MCP_NODE = "/s/node"; // script missing
    const { command } = mcpLaunch("/repo");
    expect(command).toBe(process.execPath);
  });
});

describe("mcpConfig — the JSON claude (--mcp-config) and cursor (.cursor/mcp.json) get", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of MCP_VARS) saved[k] = process.env[k];
    clearMcpVars();
  });
  afterEach(() => {
    for (const k of MCP_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("emits command + args + env for the single gtmgrid server", () => {
    process.env.GTMGRID_MCP_NODE = "/s/node";
    process.env.GTMGRID_MCP_SCRIPT = "/s/mcp.mjs";
    const cfg = JSON.parse(mcpConfig("/repo", "proj"));
    expect(cfg.mcpServers.gtmgrid).toEqual({
      command: "/s/node",
      args: ["/s/mcp.mjs"],
      env: { GTMGRID_PROJECT: "proj", GTMGRID_PORT: "8787" },
    });
  });

  it("survives Windows backslash paths through JSON round-trip intact", () => {
    process.env.GTMGRID_MCP_NODE = "C:\\sidecar\\node.exe";
    process.env.GTMGRID_MCP_SCRIPT = "C:\\sidecar\\mcp.mjs";
    const cfg = JSON.parse(mcpConfig("C:\\repo", "proj"));
    expect(cfg.mcpServers.gtmgrid.command).toBe("C:\\sidecar\\node.exe");
    expect(cfg.mcpServers.gtmgrid.args).toEqual(["C:\\sidecar\\mcp.mjs"]);
  });

  it("still threads cloud context into the gtmgrid env (regression)", () => {
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

describe("TOML rendering — what codex's `-c mcp_servers=…` flag is built from", () => {
  it("tomlString escapes backslashes then quotes", () => {
    expect(tomlString("C:\\sidecar\\node.exe")).toBe('"C:\\\\sidecar\\\\node.exe"');
    expect(tomlString('a"b')).toBe('"a\\"b"');
    expect(tomlString("plain")).toBe('"plain"');
  });

  it("tomlStringArray quotes + escapes each element", () => {
    expect(tomlStringArray(["C:\\s\\mcp.mjs"])).toBe('["C:\\\\s\\\\mcp.mjs"]');
    expect(tomlStringArray(["--import", "tsx", "/repo/x.ts"])).toBe(
      '["--import", "tsx", "/repo/x.ts"]',
    );
    expect(tomlStringArray([])).toBe("[]");
  });

  it("codexEnvToml output is unchanged by the shared escaper (regression)", () => {
    expect(codexEnvToml(mcpEnv("p"))).toBe('{ GTMGRID_PROJECT = "p", GTMGRID_PORT = "8787" }');
    expect(codexEnvToml({ GTMGRID_TOKEN: 'a"b\\c' })).toBe('{ GTMGRID_TOKEN = "a\\"b\\\\c" }');
  });

  it("a Windows codex mcp_servers fragment escapes the node command + script arg", () => {
    // Mirror the exact fragment streamCodex builds, with Windows paths.
    const command = "C:\\sidecar\\node.exe";
    const args = ["C:\\sidecar\\mcp.mjs"];
    const fragment = `gtmgrid = { command = ${tomlString(command)}, args = ${tomlStringArray(
      args,
    )}, env = ${codexEnvToml(mcpEnv("proj"))} }`;
    // Every backslash is doubled (valid TOML) — the old `command = "${launcher}"`
    // form left them single, producing invalid TOML and a failed MCP mount.
    expect(fragment).toContain('command = "C:\\\\sidecar\\\\node.exe"');
    expect(fragment).toContain('args = ["C:\\\\sidecar\\\\mcp.mjs"]');
    expect(fragment).not.toContain("C:\\sidecar"); // no un-escaped single backslash path
  });
});
