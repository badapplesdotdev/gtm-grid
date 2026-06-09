/**
 * Sandbox authorization tests — the `__hostCall` allow-list boundary.
 *
 * The QuickJS sandbox exposes a typed `sdk.<provider>.<method>(...)` surface built
 * from the `providers` map, but the underlying bridge `__hostCall` is reachable as
 * a guest global. These tests prove the boundary is enforced INSIDE the bridge
 * (not only when shaping `sdk`): a call to a (provider, method) outside `providers`
 * never reaches `dispatch` — whether made via `sdk` or by calling `__hostCall`
 * directly — while an allowed call reaches `dispatch` and returns its result.
 */

import { describe, expect, it, vi } from "vitest";
import { runFunction } from "./sandbox.js";

describe("runFunction __hostCall allow-list", () => {
  it("dispatches an ALLOWED sdk call and returns its result", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const result = await runFunction({
      code: "function(i, sdk){ return sdk.allowed.run({ x: 1 }); }",
      inputs: {},
      providers: { allowed: ["run"] },
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("allowed", "run", { x: 1 });
    expect(result).toEqual({ ok: true });
  });

  it("BLOCKS a direct __hostCall to a provider outside the allow-list (never dispatches)", async () => {
    const dispatch = vi.fn(async () => ({ secret: "leaked" }));
    // The guest reaches past `sdk` and calls the raw bridge for a connector it was
    // never granted. The bridge must refuse before `dispatch` runs. (The raw bridge
    // returns a JSON string, so the guest parses it like the `sdk` wrapper does.)
    const result = await runFunction({
      code: 'function(){ return JSON.parse(__hostCall("secret", "steal", "{}")); }',
      inputs: {},
      providers: { allowed: ["run"] },
      dispatch,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      __hostError: "sdk call not permitted: secret.steal",
    });
  });

  it("BLOCKS a direct __hostCall to an allowed provider but a NON-allowed method", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const result = await runFunction({
      code: 'function(){ return JSON.parse(__hostCall("allowed", "otherMethod", "{}")); }',
      inputs: {},
      providers: { allowed: ["run"] },
      dispatch,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      __hostError: "sdk call not permitted: allowed.otherMethod",
    });
  });

  it("a blocked call via the typed sdk surface is impossible — only granted methods exist", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    // `sdk.secret` is never materialised (not in `providers`), so referencing it
    // throws inside the guest before any bridge call — the run fails, nothing
    // dispatches. This is the allow-list's first line of defence; the __hostCall
    // gate above is the backstop for code that reaches past `sdk`.
    await expect(
      runFunction({
        code: "function(i, sdk){ return sdk.secret.steal({}); }",
        inputs: {},
        providers: { allowed: ["run"] },
        dispatch,
      }),
    ).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("allows a direct __hostCall to an explicitly granted (provider, method)", async () => {
    const dispatch = vi.fn(async () => "pong");
    const result = await runFunction({
      code: 'function(){ return JSON.parse(__hostCall("allowed", "run", "{}")); }',
      inputs: {},
      providers: { allowed: ["run"] },
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledWith("allowed", "run", {});
    expect(result).toBe("pong");
  });
});
