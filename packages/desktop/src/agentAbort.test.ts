import { describe, expect, it } from "vitest";
import {
  abortAllRuns,
  abortRun,
  type AbortControllers,
  tableAbortKey,
} from "./agentAbort";

// Per-agent abort lifecycle. The panel keeps a controller per agent so a turn on
// one tab survives switching to another; only an unmount or a TABLE switch tears
// runs down. These cover the extracted units (the desktop suite is logic-only).

describe("abortRun — abort ONE agent's in-flight turn", () => {
  it("aborts that agent's controller and clears its slot", () => {
    const controller = new AbortController();
    const map: AbortControllers = { claude: controller, codex: null, hermes: null };

    abortRun(map, "claude");

    expect(controller.signal.aborted).toBe(true);
    expect(map.claude).toBeNull();
  });

  it("leaves OTHER agents' runs untouched (the agent-switch regression)", () => {
    const claude = new AbortController();
    const codex = new AbortController();
    const map: AbortControllers = { claude, codex, hermes: null };

    // Switching away from Claude must not abort Codex's live turn (or vice versa).
    abortRun(map, "claude");

    expect(claude.signal.aborted).toBe(true);
    expect(codex.signal.aborted).toBe(false);
    expect(map.codex).toBe(codex);
  });

  it("is a no-op when the agent has no live turn", () => {
    const map: AbortControllers = { claude: null, codex: null, hermes: null };
    expect(() => abortRun(map, "claude")).not.toThrow();
  });

  it("does not abort a controller swapped in after the slot was cleared", () => {
    const first = new AbortController();
    const map: AbortControllers = { claude: first, codex: null, hermes: null };
    abortRun(map, "claude"); // first turn torn down, slot cleared

    const second = new AbortController();
    map.claude = second; // a fresh turn installs a new controller
    expect(second.signal.aborted).toBe(false);
  });
});

describe("abortAllRuns — abort EVERY agent (unmount / table switch)", () => {
  it("aborts all live controllers and clears every slot", () => {
    const claude = new AbortController();
    const codex = new AbortController();
    const map: AbortControllers = { claude, codex, hermes: null };

    abortAllRuns(map);

    expect(claude.signal.aborted).toBe(true);
    expect(codex.signal.aborted).toBe(true);
    expect(map.claude).toBeNull();
    expect(map.codex).toBeNull();
  });
});

// `tableAbortKey` is the STABLE dependency the panel's abort effect keys off. It
// must change ONLY on a real TABLE switch — never on an unrelated re-render, and
// (unlike the old key) NOT on an agent switch, since agent runs now persist.
describe("tableAbortKey — abort iff the active TABLE actually changes", () => {
  it("is STABLE across new object identities for the same table (the regression)", () => {
    const renderA = { name: "Leads", columns: ["a", "b"] };
    const renderB = { name: "Leads", columns: ["a", "b"] };
    expect(renderA).not.toBe(renderB);
    expect(tableAbortKey(renderA)).toBe(tableAbortKey(renderB));
  });

  it("changes when the user switches table / cloud project (turns must abort)", () => {
    expect(tableAbortKey({ name: "Leads", columns: ["a"] })).not.toBe(
      tableAbortKey({ name: "Accounts", columns: ["a"] }),
    );
  });

  it("is stable when only the column set changes but the table name does not", () => {
    expect(tableAbortKey({ name: "Leads", columns: ["a"] })).toBe(
      tableAbortKey({ name: "Leads", columns: ["a", "b", "c"] }),
    );
  });

  it("distinguishes a null table (local) from a named table", () => {
    expect(tableAbortKey(null)).not.toBe(tableAbortKey({ name: "Leads", columns: [] }));
    expect(tableAbortKey(null)).toBe(tableAbortKey(null));
  });

  it("changes when switching between two CLOUD tables (the cloud-stuck-table fix)", () => {
    // In cloud mode `activeTable` now follows the active cloud table, so a switch
    // between two cloud tables yields a new key — tearing down the prior turn and
    // re-orienting the agent. Previously the cloud hint never moved off the last
    // local table, so the agent stayed stuck on one table.
    expect(tableAbortKey({ name: "Trigify mentions", columns: ["a"] })).not.toBe(
      tableAbortKey({ name: "Brand mentions", columns: ["a"] }),
    );
  });
});
