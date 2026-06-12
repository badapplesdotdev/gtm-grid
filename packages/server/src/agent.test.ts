import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import {
  appendCapped,
  codexEnvToml,
  codexSandboxFlags,
  claudePermissionMode,
  contextPreamble,
  manageChildLifecycle,
  mcpEnv,
  parseAgentCloud,
  streamHermes,
  STDERR_CAP,
  type AgentCloud,
  type HermesChild,
  type HermesTransport,
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

// ── streamHermes spawn/cleanup (TRI-3305 regression) ──────────────────────
// The Hermes ACP bridge spawns a detached `hermes` child + its MCP server. On
// cleanup it must group-kill the WHOLE tree (negative pid: SIGTERM→SIGKILL), not
// `child.kill()` the parent alone — the leak that previously shipped untested.
// We inject a fake spawn (so no process is launched), a fake ProcessControl with
// hand-driven timers, and a fake transport (so no `hermes` binary is required).

/** A fake HermesChild whose close/error listeners + stdout/stderr we drive. */
function fakeHermesChild(pid: number | undefined = 7373): HermesChild & {
  close: () => void;
  error: (err: Error) => void;
} {
  // Real ChildProcess is an EventEmitter — BOTH manageChildLifecycle (dispose)
  // and streamHermes (failAllPending) subscribe to "close", so we keep arrays.
  const closeListeners: Array<() => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const noop = { on() {} } as { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  const child: HermesChild & { close: () => void; error: (err: Error) => void } = {
    pid,
    stdin: { write: () => true },
    stdout: noop,
    stderr: noop,
    on(event: "close" | "error", listener: (...a: any[]) => void) {
      if (event === "close") closeListeners.push(listener as () => void);
      else if (event === "error") errorListeners.push(listener as (err: Error) => void);
      return this;
    },
    close() {
      for (const l of closeListeners) l();
    },
    error(err: Error) {
      for (const l of errorListeners) l(err);
    },
  };
  return child;
}

/** A fake ServerResponse: records SSE writes + lets the test fire `res.close`. */
function fakeRes(): ServerResponse & { closeRes: () => void } {
  let onClose: (() => void) | null = null;
  const res = {
    writeHead() {
      return res;
    },
    write() {
      return true;
    },
    end() {
      return res;
    },
    on(event: string, listener: () => void) {
      if (event === "close") onClose = listener;
      return res;
    },
    closeRes() {
      onClose?.();
    },
  };
  return res as unknown as ServerResponse & { closeRes: () => void };
}

const FAKE_TRANSPORT: HermesTransport = {
  argv: ["/fake/hermes", "acp"],
  gtmgridMcp: { name: "gtmgrid", command: "/fake/launcher", args: [], env: [{ name: "GTMGRID_PROJECT", value: "p" }] },
  label: "local",
};

function runStreamHermes(child: HermesChild, control: ProcessControl, res: ServerResponse) {
  streamHermes(
    res,
    { message: "hi", project: "p", repoRoot: "/repo" },
    { spawn: () => child, control, resolveTransport: () => FAKE_TRANSPORT },
  );
}

describe("streamHermes — group-kill cleanup (TRI-3305 regression)", () => {
  it("group-kills the WHOLE tree (negative pid SIGTERM→SIGKILL) on res close, not child.kill()", () => {
    const child = fakeHermesChild(7373);
    const control = fakeControl();
    const res = fakeRes();
    runStreamHermes(child, control, res);

    res.closeRes(); // panel unmount / Stop / new send
    expect(control.kills).toEqual([{ pid: -7373, signal: "SIGTERM" }]);

    control.runTimer(3000); // child ignores SIGTERM through the grace
    expect(control.kills).toEqual([
      { pid: -7373, signal: "SIGTERM" },
      { pid: -7373, signal: "SIGKILL" },
    ]);
  });

  it("sends NO kill once the hermes child has already exited (avoids killing a recycled pid)", () => {
    const child = fakeHermesChild(7373);
    const control = fakeControl();
    const res = fakeRes();
    runStreamHermes(child, control, res);

    child.close(); // hermes exits on its own
    res.closeRes(); // late cleanup must be a no-op
    control.runTimer(3000);

    expect(control.kills).toEqual([]);
  });

  it("max-run timeout group-kills the tree exactly once", () => {
    const child = fakeHermesChild(7373);
    const control = fakeControl();
    const res = fakeRes();
    runStreamHermes(child, control, res);

    control.runTimer(5 * 60_000); // MAX_RUN_MS elapses
    expect(control.kills).toEqual([{ pid: -7373, signal: "SIGTERM" }]);
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
  it("other modes pass through; absent → bypass", () => {
    expect(claudePermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(claudePermissionMode("auto")).toBe("auto");
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
