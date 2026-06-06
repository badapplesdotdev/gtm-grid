/**
 * Tests for the cloud-auth client logic (T8).
 *
 * The wired auth path is email + password (Convex Auth Password provider); the
 * Convex Auth actions and the reactive `me` query are exercised end-to-end only
 * against a live deployment (a human Tauri/dev run). The pure, unit-testable
 * client logic is the active-workspace selection, which decides which workspace
 * the account bar / plan badge act on. We assert its OUTCOMES here.
 */

import { describe, expect, it } from "vitest";
import {
  enabledProviderList,
  resolveActiveWorkspace,
  type WorkspaceSummary,
} from "./auth";

const ws = (id: string, name: string): WorkspaceSummary => ({
  // Ids are opaque strings at runtime; the cast keeps the test honest to the
  // public type without pulling in Convex's branded Id machinery.
  _id: id as WorkspaceSummary["_id"],
  name,
  role: "owner",
  seatUsage: { used: 1, limit: null },
  plan: { id: null, name: "Free" },
  cloudActions: { used: 0, limit: null },
});

describe("resolveActiveWorkspace", () => {
  it("returns null when the user has no workspaces", () => {
    expect(resolveActiveWorkspace([], "anything")).toBeNull();
    expect(resolveActiveWorkspace([], null)).toBeNull();
  });

  it("returns the stored workspace when it is still present", () => {
    const list = [ws("a", "Alpha"), ws("b", "Beta")];
    expect(resolveActiveWorkspace(list, "b")).toBe(list[1]);
  });

  it("falls back to the first workspace when the stored id is stale", () => {
    const list = [ws("a", "Alpha"), ws("b", "Beta")];
    expect(resolveActiveWorkspace(list, "gone")).toBe(list[0]);
  });

  it("falls back to the first workspace when nothing is stored", () => {
    const list = [ws("a", "Alpha"), ws("b", "Beta")];
    expect(resolveActiveWorkspace(list, null)).toBe(list[0]);
  });
});

// ─── OAuth provider gating (C17) ──────────────────────────────────────────────
//
// `enabledProviderList` decides which OAuth buttons render. The key AC outcome:
// when no provider is enabled the list is empty, so the UI hides the OAuth row +
// divider entirely — the screen stays clean before any OAuth app is configured.

describe("enabledProviderList", () => {
  it("returns no providers while the query is still loading (undefined)", () => {
    expect(enabledProviderList(undefined)).toEqual([]);
  });

  it("returns no providers when neither is enabled (OAuth row stays hidden)", () => {
    expect(enabledProviderList({ github: false, google: false })).toEqual([]);
  });

  it("returns only the enabled provider when one is configured", () => {
    expect(enabledProviderList({ github: true, google: false })).toEqual([
      "github",
    ]);
    expect(enabledProviderList({ github: false, google: true })).toEqual([
      "google",
    ]);
  });

  it("returns both in display order (google first) when both are enabled", () => {
    expect(enabledProviderList({ github: true, google: true })).toEqual([
      "google",
      "github",
    ]);
  });
});
