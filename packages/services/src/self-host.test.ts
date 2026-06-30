/**
 * `isSelfHost()` — reads `GTMGRID_SELF_HOST` at call time so the same binary (and
 * tests) can toggle it. Only the exact string "1" enables self-host; anything
 * else (unset, "0", "true", "") is the hosted product.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isSelfHost } from "./self-host.js";

describe("isSelfHost", () => {
  const prev = process.env.GTMGRID_SELF_HOST;
  afterEach(() => {
    if (prev === undefined) delete process.env.GTMGRID_SELF_HOST;
    else process.env.GTMGRID_SELF_HOST = prev;
  });

  it("is true only when GTMGRID_SELF_HOST is exactly '1'", () => {
    process.env.GTMGRID_SELF_HOST = "1";
    expect(isSelfHost()).toBe(true);
  });

  it("is false when unset", () => {
    delete process.env.GTMGRID_SELF_HOST;
    expect(isSelfHost()).toBe(false);
  });

  it("is false for any non-'1' value", () => {
    for (const v of ["0", "true", "yes", "", " 1 "]) {
      process.env.GTMGRID_SELF_HOST = v;
      expect(isSelfHost()).toBe(false);
    }
  });

  it("re-reads the env each call (not cached at import)", () => {
    delete process.env.GTMGRID_SELF_HOST;
    expect(isSelfHost()).toBe(false);
    process.env.GTMGRID_SELF_HOST = "1";
    expect(isSelfHost()).toBe(true);
  });
});
