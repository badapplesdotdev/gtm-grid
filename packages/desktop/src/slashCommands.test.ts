// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "./AgentPanel";

describe("SLASH_COMMANDS — the agent chat's / menu", () => {
  const names = SLASH_COMMANDS.map((c) => c.name);

  it("offers the onboarding commands new users reach for", () => {
    expect(names).toContain("help");
    expect(names).toContain("start");
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
