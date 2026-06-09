// Unit tests for the Hermes ACP bridge's pure mapping helpers — the part that
// translates Hermes' `session/update` notifications into the SSE event shape the
// agent panel renders, plus the headless permission auto-allow. No process is
// spawned; we feed synthetic ACP payloads (shapes confirmed against a live
// `hermes acp` handshake).

import { describe, it, expect } from "vitest";
import { mapAcpUpdate, pickAllowOption, mcpConfig } from "./agent.js";

describe("mcpConfig — gtmgrid + optional Hermes-as-tool (Shape 3)", () => {
  it("contains only gtmgrid by default", () => {
    const cfg = JSON.parse(mcpConfig("/repo", "proj"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["gtmgrid"]);
    expect(cfg.mcpServers.gtmgrid.env.GTMGRID_PROJECT).toBe("proj");
  });

  it("merges an extra hermes server when provided", () => {
    const cfg = JSON.parse(mcpConfig("/repo", "proj", { hermes: { command: "hermes", args: ["mcp", "serve"] } }));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["gtmgrid", "hermes"]);
    expect(cfg.mcpServers.hermes).toEqual({ command: "hermes", args: ["mcp", "serve"] });
  });
});

describe("mapAcpUpdate — ACP session/update -> SSE events", () => {
  it("maps an assistant text chunk to a text event", () => {
    expect(
      mapAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } }),
    ).toEqual([{ type: "text", text: "hello" }]);
  });

  it("drops empty text chunks", () => {
    expect(mapAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } })).toEqual([]);
  });

  it("maps a tool_call to a tool event and strips the gtmgrid prefix", () => {
    expect(
      mapAcpUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-ab12",
        title: "gtmgrid: add_column",
        kind: "other",
        status: "pending",
        rawInput: { name: "Email" },
      }),
    ).toEqual([{ type: "tool", name: "add_column", raw: "tc-ab12", input: { name: "Email" } }]);
  });

  it("strips Hermes' mcp_<server>_ tool-name prefix (as seen live)", () => {
    expect(
      mapAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-x", title: "mcp_gtmgrid_list_tables", kind: "other" }),
    ).toEqual([{ type: "tool", name: "list_tables", raw: "tc-x", input: {} }]);
  });

  it("emits tool_result + a grid refresh on a completed tool_call_update (rawOutput)", () => {
    expect(
      mapAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc-ab12", status: "completed", rawOutput: '{"ran":3}' }),
    ).toEqual([{ type: "tool_result", result: '{"ran":3}' }, { type: "grid" }]);
  });

  it("reads result text from content blocks when rawOutput is absent (failed)", () => {
    expect(
      mapAcpUpdate({ sessionUpdate: "tool_call_update", status: "failed", content: [{ content: { text: "boom" } }] }),
    ).toEqual([{ type: "tool_result", result: "boom" }, { type: "grid" }]);
  });

  it("emits nothing for an in-flight (pending) tool_call_update", () => {
    expect(mapAcpUpdate({ sessionUpdate: "tool_call_update", status: "pending" })).toEqual([]);
  });

  it("ignores informational / unknown updates and nullish input", () => {
    expect(mapAcpUpdate({ sessionUpdate: "usage_update", used: 1 })).toEqual([]);
    expect(mapAcpUpdate({ sessionUpdate: "available_commands_update" })).toEqual([]);
    expect(mapAcpUpdate(undefined)).toEqual([]);
    expect(mapAcpUpdate(null)).toEqual([]);
  });
});

describe("pickAllowOption — headless permission auto-allow", () => {
  it("prefers a one-shot allow", () => {
    expect(
      pickAllowOption([
        { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ]),
    ).toBe("allow_once");
  });

  it("falls back to an allow-always option", () => {
    expect(
      pickAllowOption([
        { optionId: "allow_session", kind: "allow_always" },
        { optionId: "deny", kind: "reject_once" },
      ]),
    ).toBe("allow_session");
  });

  it("returns null when no option allows (deny-only)", () => {
    expect(pickAllowOption([{ optionId: "deny", kind: "reject_once" }])).toBeNull();
  });

  it("returns null for a non-array", () => {
    expect(pickAllowOption(undefined)).toBeNull();
  });
});
