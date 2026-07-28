import { describe, expect, it } from "vitest";
import { shouldServeInngest } from "./serve-policy";

describe("shouldServeInngest", () => {
  it("blocks Vercel preview deployments from registering or executing functions", () => {
    expect(shouldServeInngest("preview")).toBe(false);
    expect(shouldServeInngest(undefined, "preview")).toBe(false);
  });

  it("keeps production, custom staging, and local development enabled", () => {
    expect(shouldServeInngest("production")).toBe(true);
    expect(shouldServeInngest("staging", "preview")).toBe(true);
    expect(shouldServeInngest(undefined)).toBe(true);
  });
});
