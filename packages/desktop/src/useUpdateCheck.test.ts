/** Tests for the update-check version comparator. */
import { describe, expect, it } from "vitest";
import { isNewerVersion } from "./useUpdateCheck";

describe("isNewerVersion", () => {
  it("detects a newer patch / minor / major", () => {
    expect(isNewerVersion("0.3.7", "0.3.6")).toBe(true);
    expect(isNewerVersion("0.4.0", "0.3.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
  });
  it("is false for equal or older", () => {
    expect(isNewerVersion("0.3.6", "0.3.6")).toBe(false);
    expect(isNewerVersion("0.3.5", "0.3.6")).toBe(false);
    expect(isNewerVersion("0.2.9", "0.3.0")).toBe(false);
  });
  it("tolerates a leading v and missing parts", () => {
    expect(isNewerVersion("v0.3.7", "0.3.6")).toBe(true);
    expect(isNewerVersion("1", "0.9.9")).toBe(true);
  });
});
