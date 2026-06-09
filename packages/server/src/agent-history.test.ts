/**
 * Tests for the native agent-history readers — OFFLINE against fixture transcript
 * dirs written to a temp folder (no real ~/.claude or ~/.codex needed). Covers the
 * Claude project-dir encoding, title/message extraction, tool-result stitching,
 * and Codex's cwd filtering of a global rollout store.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __test, encodeClaudeDir } from "./agent-history.js";

const REPO = "/Users/dev/repos/gtm-grid";
let root: string;

const jsonl = (path: string, lines: unknown[]) =>
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gtmgrid-hist-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("encodeClaudeDir", () => {
  it("replaces every non-alphanumeric char with '-' (matches Claude Code)", () => {
    expect(encodeClaudeDir("/Users/dev/repos/gtm-grid")).toBe("-Users-dev-repos-gtm-grid");
    expect(encodeClaudeDir("/Applications/GTM Grid.app")).toBe("-Applications-GTM-Grid-app");
  });
});

describe("Claude transcripts", () => {
  const seed = () => {
    const dir = join(root, encodeClaudeDir(REPO));
    mkdirSync(dir, { recursive: true });
    jsonl(join(dir, "sess-1.jsonl"), [
      { type: "ai-title", title: "Build a webhook table" },
      { type: "user", message: { role: "user", content: "make a webhook table" } },
      {
        type: "assistant",
        message: { role: "assistant", content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "On it." },
          { type: "tool_use", name: "mcp__gtmgrid__add_table", input: { name: "Webhook" } },
        ] },
      },
      { type: "user", message: { role: "user", content: [
        { type: "tool_result", content: [{ type: "text", text: "created table id=42" }] },
      ] } },
    ]);
    return dir;
  };

  it("lists a session with its ai-title + message count", () => {
    seed();
    const list = __test.listClaudeSessions(REPO, root);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "sess-1", title: "Build a webhook table", messageCount: 2 });
  });

  it("reads the transcript, mapping text/tools + stitching the tool result", () => {
    seed();
    const msgs = __test.readClaudeSession(REPO, "sess-1", root);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "user", text: "make a webhook table", tools: [] });
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].text).toBe("On it.");
    expect(msgs[1].tools[0]).toMatchObject({ name: "add_table", input: { name: "Webhook" }, result: "created table id=42" });
  });

  it("returns [] for an unknown project / session", () => {
    expect(__test.listClaudeSessions("/Users/dev/repos/nope", root)).toEqual([]);
    expect(__test.readClaudeSession(REPO, "missing", root)).toEqual([]);
  });

  it("turns a slash-command session into a clean '/command' title", () => {
    const dir = join(root, encodeClaudeDir(REPO));
    mkdirSync(dir, { recursive: true });
    jsonl(join(dir, "sess-cmd.jsonl"), [
      { type: "user", message: { role: "user", content: "<command-message>dev-workflow</command-message> <command-name>/dev-workflow</command-name>" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "running" }] } },
    ]);
    const list = __test.listClaudeSessions(REPO, root);
    expect(list[0].title).toBe("/dev-workflow");
  });

  it("falls back to the first non-preamble user message when there's no ai-title", () => {
    const dir = join(root, encodeClaudeDir(REPO));
    mkdirSync(dir, { recursive: true });
    jsonl(join(dir, "sess-2.jsonl"), [
      { type: "user", message: { role: "user", content: "# AGENTS.md instructions ..." } },
      { type: "user", message: { role: "user", content: "actually do the thing" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ]);
    const list = __test.listClaudeSessions(REPO, root);
    expect(list[0].title).toBe("actually do the thing");
  });
});

describe("Codex rollouts", () => {
  const rollout = (day: string, id: string, cwd: string, msgs: Array<[string, string]>) => {
    const dir = join(root, "2026", "06", day);
    mkdirSync(dir, { recursive: true });
    jsonl(join(dir, `rollout-2026-06-${day}T10-00-00-${id}.jsonl`), [
      { type: "session_meta", payload: { id, cwd, timestamp: "2026-06-01T10:00:00Z" } },
      ...msgs.map(([type, message]) => ({ type: "event_msg", payload: { type, message } })),
    ]);
  };

  it("lists only rollouts whose session_meta cwd matches the project", () => {
    rollout("01", "aaaa-1111", REPO, [["user_message", "hi from gtm-grid"], ["agent_message", "hello"]]);
    rollout("02", "bbbb-2222", "/Users/dev/repos/other", [["user_message", "different project"]]);
    const list = __test.listCodexSessions(REPO, root);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "aaaa-1111", title: "hi from gtm-grid", messageCount: 2 });
  });

  it("reads a rollout's user/agent messages by id", () => {
    rollout("01", "aaaa-1111", REPO, [["user_message", "hi"], ["agent_message", "yo"]]);
    const msgs = __test.readCodexSession(REPO, "aaaa-1111", root);
    expect(msgs).toEqual([
      { role: "user", text: "hi", tools: [] },
      { role: "assistant", text: "yo", tools: [] },
    ]);
  });
});
