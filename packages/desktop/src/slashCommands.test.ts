// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS, ONBOARDING_COMMAND } from "./AgentPanel";

describe("SLASH_COMMANDS — the agent chat's / menu", () => {
  const names = SLASH_COMMANDS.map((c) => c.name);

  it("offers the /start onboarding command (and not /help — we only ship /start)", () => {
    expect(names).toContain("start");
    expect(names).not.toContain("help");
  });

  it("keeps the existing /goal command", () => {
    expect(names).toContain("goal");
  });

  it("every command has a name and a description (drives the typeahead UI)", () => {
    for (const c of SLASH_COMMANDS) {
      expect(c.name).toBeTruthy();
      expect(c.description).toBeTruthy();
    }
  });
});

describe("ONBOARDING_COMMAND — what send() intercepts locally (never forwarded to the CLI)", () => {
  it("matches /start (case-insensitive, with or without trailing args)", () => {
    expect(ONBOARDING_COMMAND.test("/start")).toBe(true);
    expect(ONBOARDING_COMMAND.test("/START")).toBe(true);
    expect(ONBOARDING_COMMAND.test("/start now")).toBe(true);
  });

  it("does NOT match /goal, plain text, or a /start-prefixed word", () => {
    expect(ONBOARDING_COMMAND.test("/goal grow pipeline")).toBe(false);
    expect(ONBOARDING_COMMAND.test("start without slash")).toBe(false);
    expect(ONBOARDING_COMMAND.test("/started")).toBe(false);
    expect(ONBOARDING_COMMAND.test("/help")).toBe(false);
  });
});
