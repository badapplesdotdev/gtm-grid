import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { cn, onActivateKey } from "./utils";

describe("cn — clsx + tailwind-merge class join", () => {
  it("joins plain class strings with a single space", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("drops falsy conditionals (false / null / undefined / empty)", () => {
    expect(cn("base", false, null, undefined, "", "end")).toBe("base end");
  });

  it("resolves object syntax by truthiness", () => {
    expect(cn({ active: true, disabled: false, open: 1 as unknown as boolean })).toBe("active open");
  });

  it("flattens nested arrays of classes", () => {
    expect(cn(["a", ["b", "c"]], "d")).toBe("a b c d");
  });

  it("de-dupes conflicting tailwind utilities, keeping the last", () => {
    // tailwind-merge: later padding wins over earlier on the same axis.
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("px-2 px-4")).toBe("px-4");
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
  });

  it("keeps non-conflicting tailwind utilities side by side", () => {
    expect(cn("p-2", "m-4")).toBe("p-2 m-4");
  });

  it("returns an empty string for no (or all-falsy) inputs", () => {
    expect(cn()).toBe("");
    expect(cn(false, null, undefined)).toBe("");
  });
});

describe("onActivateKey — Enter/Space keyboard activation", () => {
  /** Build the minimal slice of a React.KeyboardEvent the handler reads. */
  const evt = (
    key: string,
    mods: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey">> = {},
  ): KeyboardEvent => {
    const preventDefault = vi.fn();
    return {
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...mods,
      preventDefault,
    } as unknown as KeyboardEvent;
  };

  it("fires the handler and prevents default on Enter", () => {
    const fn = vi.fn();
    const e = evt("Enter");
    onActivateKey(fn)(e);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("fires the handler and prevents default on Space", () => {
    const fn = vi.fn();
    const e = evt(" ");
    onActivateKey(fn)(e);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("ignores any other key (no handler, no preventDefault)", () => {
    const fn = vi.fn();
    for (const key of ["Tab", "a", "Escape", "Spacebar", "ArrowDown", "Shift"]) {
      const e = evt(key);
      onActivateKey(fn)(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("ignores modified Enter/Space (meta / ctrl / alt held)", () => {
    const fn = vi.fn();
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      const enter = evt("Enter", mods);
      const space = evt(" ", mods);
      onActivateKey(fn)(enter);
      onActivateKey(fn)(space);
      expect(enter.preventDefault).not.toHaveBeenCalled();
      expect(space.preventDefault).not.toHaveBeenCalled();
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns a reusable handler that fires once per event", () => {
    const fn = vi.fn();
    const handler = onActivateKey(fn);
    handler(evt("Enter"));
    handler(evt(" "));
    handler(evt("Tab"));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
