import { describe, expect, it, vi } from "vitest";
import {
  appendCapped,
  codexEnvToml,
  codexSandboxFlags,
  claudePermissionMode,
  contextPreamble,
  manageChildLifecycle,
  mcpEnv,
  parseAgentCloud,
  parseClaudeInit,
  permissionEventFromToolResult,
  questionEventFromToolResult,
  STDERR_CAP,
  type AgentCloud,
  type ManagedChild,
  type ProcessControl,
} from "./agent.js";

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

  it("returns undefined for a missing/blank REQUIRED field (no half-activation)", () => {
    expect(parseAgentCloud({ ...CLOUD, token: "" })).toBeUndefined();
    expect(parseAgentCloud({ ...CLOUD, projectId: undefined })).toBeUndefined();
  });

  it("tableId is OPTIONAL — a cloud context resolves with no active table loaded", () => {
    expect(parseAgentCloud({ ...CLOUD, tableId: undefined })).toEqual({ ...CLOUD, tableId: undefined });
  });

  it("returns undefined for non-object / absent input (local mode)", () => {
    expect(parseAgentCloud(undefined)).toBeUndefined();
    expect(parseAgentCloud(null)).toBeUndefined();
    expect(parseAgentCloud("nope")).toBeUndefined();
  });
});

describe("mcpEnv — the env the spawned MCP receives (data-source selection)", () => {
  it("LOCAL: GTMGRID_PROJECT plus the sidecar port (for background-run delegation)", () => {
    expect(mcpEnv("my-project")).toEqual({
      GTMGRID_PROJECT: "my-project",
      GTMGRID_PORT: "8787",
    });
  });

  it("CLOUD: threads mode + apiUrl/token/workspace/project/table", () => {
    expect(mcpEnv("my-project", CLOUD)).toEqual({
      GTMGRID_PROJECT: "my-project",
      GTMGRID_PORT: "8787",
      GTMGRID_MODE: "cloud",
      GTMGRID_API_URL: "https://app.test",
      GTMGRID_TOKEN: "secret-bearer",
      GTMGRID_WORKSPACE_ID: "ws_1",
      GTMGRID_CLOUD_PROJECT: "proj_1",
      GTMGRID_CLOUD_TABLE: "tbl_1",
    });
  });

  it("adds GTMGRID_PERMISSION_MODE when a mode is given, omits approval vars when absent", () => {
    const env = mcpEnv("p", undefined, "auto");
    expect(env.GTMGRID_PERMISSION_MODE).toBe("auto");
    expect(env.GTMGRID_APPROVED_TOOL).toBeUndefined();
  });

  it("threads a human approval into GTMGRID_APPROVED_* (the model-inaccessible unlock)", () => {
    const env = mcpEnv("p", undefined, "acceptEdits", { tool: "delete_rows", argsHash: "abc123" });
    expect(env).toMatchObject({
      GTMGRID_PERMISSION_MODE: "acceptEdits",
      GTMGRID_APPROVED_TOOL: "delete_rows",
      GTMGRID_APPROVED_ARGS_HASH: "abc123",
    });
  });
});

describe("permissionEventFromToolResult — confirmationRequired → permission_request SSE", () => {
  it("builds a permission_request event from a gate's approvalRequest payload", () => {
    const raw = JSON.stringify({
      confirmationRequired: true,
      approvalRequest: { pendingId: "pr_x", tool: "delete_rows", argsHash: "h", mode: "auto", action: "Delete rows", willAffect: 4200, target: "Leads" },
    });
    expect(permissionEventFromToolResult(raw)).toEqual({
      type: "permission_request",
      pendingId: "pr_x",
      tool: "delete_rows",
      argsHash: "h",
      mode: "auto",
      action: "Delete rows",
      willAffect: 4200,
      target: "Leads",
    });
  });
  it("returns null for an ordinary tool result or non-JSON", () => {
    expect(permissionEventFromToolResult(JSON.stringify({ added: 5 }))).toBeNull();
    expect(permissionEventFromToolResult("not json")).toBeNull();
    expect(permissionEventFromToolResult(JSON.stringify({ confirmationRequired: true }))).toBeNull();
  });
});

describe("questionEventFromToolResult — ask_user_question → ask_user SSE", () => {
  it("builds an ask_user event from an askUserQuestion payload", () => {
    const questions = [
      { header: "AI model", question: "Which model?", options: [{ label: "Haiku" }, { label: "Sonnet" }] },
    ];
    const raw = JSON.stringify({ askUserQuestion: true, questions, message: "STOP." });
    expect(questionEventFromToolResult(raw)).toEqual({ type: "ask_user", questions });
  });
  it("returns null for an ordinary tool result, non-JSON, or a malformed payload", () => {
    expect(questionEventFromToolResult(JSON.stringify({ added: 5 }))).toBeNull();
    expect(questionEventFromToolResult("not json")).toBeNull();
    expect(questionEventFromToolResult(JSON.stringify({ askUserQuestion: true }))).toBeNull();
  });
});

describe("codexEnvToml — safe inline-TOML rendering for the codex -c flag", () => {
  it("renders the local env as a quoted TOML table", () => {
    expect(codexEnvToml(mcpEnv("p"))).toBe('{ GTMGRID_PROJECT = "p", GTMGRID_PORT = "8787" }');
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

// ── Process-group cleanup (TRI-3305) ──────────────────────────────────────
// A fake child + a fake ProcessControl with hand-driven timers so we can assert,
// offline and deterministically, that cleanup signals the whole GROUP (negative
// pid) and escalates SIGTERM → SIGKILL — and never signals after the child exits.

/** A fake spawned child whose `close` listener we can fire manually. */
function fakeChild(pid: number | undefined = 4242): ManagedChild & { close: () => void } {
  let onClose: (() => void) | null = null;
  return {
    pid,
    on(event, listener) {
      if (event === "close") onClose = listener;
      return this;
    },
    close() {
      onClose?.();
    },
  };
}

/** A ProcessControl that records kills and lets the test fire pending timers. */
function fakeControl(opts: { killThrows?: boolean } = {}): ProcessControl & {
  kills: Array<{ pid: number; signal: string }>;
  runTimer: (ms: number) => void;
  pending: () => number[];
} {
  const kills: Array<{ pid: number; signal: string }> = [];
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  return {
    kills,
    kill(pid, signal) {
      if (opts.killThrows) {
        const err = new Error("ESRCH");
        throw err;
      }
      kills.push({ pid, signal });
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle) {
      timers.delete(handle as unknown as number);
    },
    runTimer(ms) {
      const due: Array<[number, () => void]> = [];
      for (const [id, t] of timers) if (t.ms === ms) due.push([id, t.fn]);
      for (const [id, fn] of due) {
        timers.delete(id);
        fn();
      }
    },
    pending() {
      const out: number[] = [];
      for (const t of timers.values()) out.push(t.ms);
      return out;
    },
  };
}

describe("manageChildLifecycle — group-kill cleanup (TRI-3305)", () => {
  it("terminate() signals the whole GROUP with SIGTERM (negative pid), not just the child", () => {
    const child = fakeChild(4242);
    const control = fakeControl();
    const { terminate } = manageChildLifecycle(child, {
      onTimeout: () => {},
      control,
      graceMs: 3000,
      maxRunMs: 60_000,
    });

    terminate();

    expect(control.kills).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
  });

  it("escalates to SIGKILL on the GROUP after the grace when the child ignores SIGTERM", () => {
    const child = fakeChild(4242);
    const control = fakeControl();
    const { terminate } = manageChildLifecycle(child, {
      onTimeout: () => {},
      control,
      graceMs: 3000,
      maxRunMs: 60_000,
    });

    terminate();
    control.runTimer(3000); // grace elapses, child still alive

    expect(control.kills).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
  });

  it("does NOT fire SIGKILL if the child closes within the grace (clears the timer)", () => {
    const child = fakeChild(4242);
    const control = fakeControl();
    const { terminate } = manageChildLifecycle(child, {
      onTimeout: () => {},
      control,
      graceMs: 3000,
      maxRunMs: 60_000,
    });

    terminate(); // SIGTERM
    child.close(); // child exits before grace elapses
    control.runTimer(3000); // any leftover timer must be a no-op

    expect(control.kills).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
  });

  it("sends NO signal at all when the child has already closed (avoids killing a recycled pid)", () => {
    const child = fakeChild(4242);
    const control = fakeControl();
    const { terminate } = manageChildLifecycle(child, {
      onTimeout: () => {},
      control,
      graceMs: 3000,
      maxRunMs: 60_000,
    });

    child.close();
    terminate();

    expect(control.kills).toEqual([]);
  });

  it("max-run timeout terminates the group and invokes onTimeout once", () => {
    const child = fakeChild(4242);
    const control = fakeControl();
    const onTimeout = vi.fn();
    manageChildLifecycle(child, { onTimeout, control, graceMs: 3000, maxRunMs: 60_000 });

    control.runTimer(60_000); // max-run elapses

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(control.kills).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
  });

  it("swallows an ESRCH from process.kill (group already gone)", () => {
    const child = fakeChild(4242);
    const control = fakeControl({ killThrows: true });
    const { terminate } = manageChildLifecycle(child, {
      onTimeout: () => {},
      control,
      graceMs: 3000,
      maxRunMs: 60_000,
    });

    expect(() => terminate()).not.toThrow();
  });

  it("is a no-op when the child has no pid", () => {
    const child = { ...fakeChild(4242), pid: undefined };
    const control = fakeControl();
    const { terminate } = manageChildLifecycle(child, {
      onTimeout: () => {},
      control,
      graceMs: 3000,
      maxRunMs: 60_000,
    });

    terminate();
    control.runTimer(3000);

    expect(control.kills).toEqual([]);
  });
});

describe("manageChildLifecycle — idle vs ceiling turn timeouts", () => {
  const OPTS = { graceMs: 3000, idleMs: 60_000, maxRunMs: 600_000 } as const;

  it("idle timeout terminates the group and reports reason 'idle' when the child goes quiet", () => {
    const child = fakeChild(4242);
    const control = fakeControl();
    const onTimeout = vi.fn();
    manageChildLifecycle(child, { onTimeout, control, ...OPTS });

    control.runTimer(60_000); // idle window elapses with no output

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith("idle");
    expect(control.kills).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
  });

  it("touch() keeps exactly one idle timer armed (no leak) and doesn't fire while streaming", () => {
    const child = fakeChild(4242);
    const control = fakeControl();
    const onTimeout = vi.fn();
    const { touch } = manageChildLifecycle(child, { onTimeout, control, ...OPTS });

    touch();
    touch();
    touch();

    // One idle (60s) timer, not three — touch must clear before re-arming.
    expect(control.pending().filter((ms) => ms === 60_000)).toHaveLength(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("ceiling timeout still fires while the child keeps streaming (touch resets idle only)", () => {
    const child = fakeChild(4242);
    const control = fakeControl();
    const onTimeout = vi.fn();
    const { touch } = manageChildLifecycle(child, { onTimeout, control, ...OPTS });

    touch(); // resets idle but never the ceiling
    control.runTimer(600_000); // absolute ceiling elapses

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith("ceiling");
    expect(control.kills).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
  });

  it("the first turn timeout cancels its sibling so onTimeout fires exactly once", () => {
    const child = fakeChild(4242);
    const control = fakeControl();
    const onTimeout = vi.fn();
    manageChildLifecycle(child, { onTimeout, control, ...OPTS });

    control.runTimer(60_000); // idle fires first
    control.runTimer(600_000); // ceiling was cancelled — must be a no-op

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith("idle");
  });

  it("touch() after the child closes does not re-arm the idle timer", () => {
    const child = fakeChild(4242);
    const control = fakeControl();
    const onTimeout = vi.fn();
    const { touch } = manageChildLifecycle(child, { onTimeout, control, ...OPTS });

    child.close(); // dispose clears both turn timers
    touch(); // must be a no-op now that the child has exited

    expect(control.pending().filter((ms) => ms === 60_000)).toHaveLength(0);
    control.runTimer(60_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe("appendCapped — bound the stderr buffer (TRI-3305)", () => {
  it("returns the concatenation while under the cap", () => {
    expect(appendCapped("ab", "cd", 8)).toBe("abcd");
  });

  it("keeps only the trailing `cap` bytes once it overflows", () => {
    expect(appendCapped("abcd", "efgh", 4)).toBe("efgh");
    expect(appendCapped("abcdef", "gh", 4)).toBe("efgh");
  });

  it("caps a flood of stderr to the last STDERR_CAP bytes", () => {
    let buf = "";
    for (let i = 0; i < 1000; i++) buf = appendCapped(buf, "x".repeat(1024));
    expect(buf.length).toBe(STDERR_CAP);
  });
});

describe("contextPreamble — bakes in the /goal slash-command protocol", () => {
  it("teaches /goal in the base manual (always injected, no context needed)", () => {
    const p = contextPreamble();
    expect(p).toContain("## Slash commands");
    expect(p).toContain("/goal");
    // The protocol's spine — plan then execute autonomously.
    expect(p).toMatch(/objective/i);
    expect(p).toMatch(/Execute autonomously/i);
  });

  it("keeps the /goal protocol when an active table is present", () => {
    const p = contextPreamble({ tableName: "Leads", columns: ["Email"] });
    expect(p).toContain("/goal");
    expect(p).toContain('viewing **"Leads"**');
  });

  it("does NOT teach /help or /start in the preamble (handled client-side; they collide with CLI built-ins)", () => {
    const p = contextPreamble();
    expect(p).not.toContain("/help");
    expect(p).not.toContain("/start");
  });
});

describe("parseClaudeInit — read MCP connection status from Claude's init event (Windows debug signal)", () => {
  it("reports gtmgrid connected + counts only its tools", () => {
    const e = {
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "gtmgrid", status: "connected" }],
      tools: ["Bash", "mcp__gtmgrid__get_table", "mcp__gtmgrid__add_rows", "Read"],
    };
    expect(parseClaudeInit(e)).toEqual({
      mcpConnected: true,
      gtmgridTools: 2,
      mcpServersRaw: '[{"name":"gtmgrid","status":"connected"}]',
    });
  });

  it("reports NOT connected + captures the raw status when gtmgrid failed (the Windows failure)", () => {
    const e = {
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "gtmgrid", status: "failed" }],
      tools: ["Bash", "Read"],
    };
    // mcpServersRaw is the "why" payload — it preserves whatever Claude reported.
    expect(parseClaudeInit(e)).toEqual({
      mcpConnected: false,
      gtmgridTools: 0,
      mcpServersRaw: '[{"name":"gtmgrid","status":"failed"}]',
    });
  });

  it("reports NOT connected when gtmgrid is absent from mcp_servers", () => {
    expect(parseClaudeInit({ type: "system", subtype: "init", mcp_servers: [], tools: [] })).toEqual({
      mcpConnected: false,
      gtmgridTools: 0,
      mcpServersRaw: "[]",
    });
  });

  it("returns null for any non-init event (so the turn loop ignores it)", () => {
    expect(parseClaudeInit({ type: "assistant" })).toBeNull();
    expect(parseClaudeInit({ type: "system", subtype: "other" })).toBeNull();
    expect(parseClaudeInit(null)).toBeNull();
    expect(parseClaudeInit("not an object")).toBeNull();
  });

  it("is defensive about missing/malformed fields", () => {
    expect(parseClaudeInit({ type: "system", subtype: "init" })).toEqual({
      mcpConnected: false,
      gtmgridTools: 0,
      mcpServersRaw: "[]",
    });
  });
});

describe("codexSandboxFlags — codex exec uses the resume-compatible bypass for every mode", () => {
  it("returns the full-bypass flag regardless of mode (works on exec AND exec resume)", () => {
    for (const m of ["plan", "auto", "acceptEdits", "bypassPermissions", undefined, "weird"]) {
      expect(codexSandboxFlags(m as string | undefined)).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    }
  });
});

describe("claudePermissionMode — composer mode → claude --permission-mode", () => {
  it("plan maps to bypassPermissions (research tools must not be denied)", () => {
    expect(claudePermissionMode("plan")).toBe("bypassPermissions");
  });
  it("auto maps to the valid CLI 'default' (NOT the invalid 'auto' flag)", () => {
    expect(claudePermissionMode("auto")).toBe("default");
  });
  it("acceptEdits/bypassPermissions pass through; absent → bypass", () => {
    expect(claudePermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(claudePermissionMode("bypassPermissions")).toBe("bypassPermissions");
    expect(claudePermissionMode(undefined)).toBe("bypassPermissions");
  });
});

describe("contextPreamble — PLAN MODE note", () => {
  it("injects the plan-only protocol only when mode is 'plan'", () => {
    expect(contextPreamble(undefined, "plan")).toContain("PLAN MODE (active)");
    expect(contextPreamble(undefined, "plan")).toMatch(/do NOT.*ExitPlanMode/i);
    expect(contextPreamble(undefined, "bypassPermissions")).not.toContain("PLAN MODE (active)");
    expect(contextPreamble(undefined)).not.toContain("PLAN MODE (active)");
  });
  it("keeps the plan note alongside an active table", () => {
    const p = contextPreamble({ tableName: "Leads", columns: ["Email"] }, "plan");
    expect(p).toContain("PLAN MODE (active)");
    expect(p).toContain('viewing **"Leads"**');
  });
});
