/**
 * Unit tests for the cloud Social Signals catalog — the pure result-extraction +
 * scheduling helpers shared by {@link SignalService} and the Inngest worker. No
 * Effect, no DB, no network: these are plain functions over Trigify-shaped JSON,
 * so they're tested directly. Mirrors the extractors the desktop sidecar uses, so
 * a divergence here means desktop and cloud would dedupe/map differently.
 */

import { describe, expect, it } from "vitest";
import {
  getPath,
  getSignalSource,
  isBindingDue,
  mapResultToCells,
  normalizeResults,
  resultKey,
  toCellValue,
} from "./catalog.js";

describe("getPath", () => {
  it("reads a dotted nested path", () => {
    expect(getPath({ author: { profile_url: "u" } }, "author.profile_url")).toBe("u");
  });

  it("falls back across `a|b` alternatives to the first non-empty", () => {
    expect(getPath({ created_at: "t" }, "published_at|created_at")).toBe("t");
    expect(getPath({ published_at: "", created_at: "t" }, "published_at|created_at")).toBe("t");
  });

  it("returns undefined when no alternative resolves", () => {
    expect(getPath({ x: 1 }, "a.b|c")).toBeUndefined();
    expect(getPath(null, "a")).toBeUndefined();
  });

  it("synthesizes a display name via the __name pseudo-path", () => {
    expect(getPath({ author: { name: "Ada" } }, "__name")).toBe("Ada");
    expect(getPath({ first_name: "Ada", last_name: "L" }, "__name")).toBe("Ada L");
  });
});

describe("resultKey", () => {
  it("prefers a stable id", () => {
    expect(resultKey({ id: "abc", url: "u" })).toBe("abc");
    expect(resultKey({ post: { id: "p1" } })).toBe("p1");
  });

  it("falls back to url then to author+timestamp composite", () => {
    expect(resultKey({ url: "https://x/y" })).toBe("https://x/y");
    expect(
      resultKey({ author: { profile_url: "p" }, published_at: "2026" }),
    ).toBe("p|2026");
  });

  it("is stable for the same input (dedupe relies on it)", () => {
    const r = { author: { profile_url: "p" }, created_at: "2026" };
    expect(resultKey(r)).toBe(resultKey(r));
  });
});

describe("normalizeResults", () => {
  it("passes through a bare array", () => {
    expect(normalizeResults([{ id: 1 }])).toEqual([{ id: 1 }]);
  });

  it("unwraps the common envelope shapes", () => {
    expect(normalizeResults({ results: [1] })).toEqual([1]);
    expect(normalizeResults({ data: [2] })).toEqual([2]);
    expect(normalizeResults({ items: [3] })).toEqual([3]);
    expect(normalizeResults({ profiles: [4] })).toEqual([4]);
  });

  it("returns [] for an unrecognized / empty response", () => {
    expect(normalizeResults(null)).toEqual([]);
    expect(normalizeResults({})).toEqual([]);
  });
});

describe("toCellValue", () => {
  it("passes scalars through and empties null/undefined", () => {
    expect(toCellValue("s")).toBe("s");
    expect(toCellValue(7)).toBe(7);
    expect(toCellValue(true)).toBe(true);
    expect(toCellValue(null)).toBe("");
    expect(toCellValue(undefined)).toBe("");
  });

  it("JSON-stringifies objects/arrays", () => {
    expect(toCellValue({ a: 1 })).toBe('{"a":1}');
    expect(toCellValue([1, 2])).toBe("[1,2]");
  });
});

describe("mapResultToCells", () => {
  it("maps configured columns and drops empty values", () => {
    const cells = mapResultToCells(
      { author: { profile_url: "p" }, title: "" },
      [
        { key: "author.profile_url", name: "Profile URL" },
        { key: "title", name: "Title" },
      ],
    );
    expect(cells).toEqual({ "Profile URL": "p" });
  });
});

describe("isBindingDue", () => {
  const HOUR = 60 * 60 * 1000;

  it("never runs a manual or disabled binding", () => {
    expect(isBindingDue({ enabled: true, schedule: "manual", lastSyncedAt: null }, 0)).toBe(false);
    expect(isBindingDue({ enabled: false, schedule: "hourly", lastSyncedAt: null }, 0)).toBe(false);
  });

  it("runs a never-synced binding immediately", () => {
    expect(isBindingDue({ enabled: true, schedule: "hourly", lastSyncedAt: null }, 123)).toBe(true);
  });

  it("respects the per-schedule interval", () => {
    const now = 10 * HOUR;
    expect(isBindingDue({ enabled: true, schedule: "hourly", lastSyncedAt: now - HOUR }, now)).toBe(true);
    expect(isBindingDue({ enabled: true, schedule: "hourly", lastSyncedAt: now - HOUR / 2 }, now)).toBe(false);
    expect(isBindingDue({ enabled: true, schedule: "daily", lastSyncedAt: now - HOUR }, now)).toBe(false);
  });
});

describe("getSignalSource", () => {
  it("resolves a known source and its Trigify paths", () => {
    const s = getSignalSource("linkedin-posts");
    expect(s?.kind).toBe("search");
    expect(s?.createPath).toBe("/v1/searches/linkedin/posts");
  });

  it("returns undefined for an unknown source", () => {
    expect(getSignalSource("nope")).toBeUndefined();
  });
});
