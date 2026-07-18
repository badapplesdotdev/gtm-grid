import { describe, expect, it } from "vitest";
import { appendErrorNotice, incompleteStreamMessage } from "./AgentPanel";

describe("agent stream interruption state", () => {
  it("does not treat a clean done or surfaced error as an unexpected EOF", () => {
    expect(incompleteStreamMessage("claude", { sawDone: true, sawEnd: true, sawError: false })).toBeNull();
    expect(incompleteStreamMessage("claude", { sawDone: false, sawEnd: true, sawError: true })).toBeNull();
  });

  it("distinguishes a clean early exit from a dropped stream", () => {
    expect(incompleteStreamMessage("claude", { sawDone: false, sawEnd: true, sawError: false })).toContain("before returning a final result");
    expect(incompleteStreamMessage("codex", { sawDone: false, sawEnd: false, sawError: false })).toContain("ended unexpectedly");
  });

  it("marks every unresolved tool failed and always appends the error notice", () => {
    const message = appendErrorNotice({
      role: "assistant",
      text: "Moving to the email-finding step.",
      parts: [{ kind: "text", text: "Moving to the email-finding step." }, { kind: "tool", ref: 0 }],
      tools: [{ name: "run_column", input: { column: "email_finder" } }],
    }, "Claude turn was terminated after 300s with no output");
    expect(message.error).toBe(true);
    expect(message.tools[0]?.error).toContain("terminated");
    expect(message.text).toContain("⚠️ Claude turn was terminated");
  });
});
