/**
 * Pure presence-view tests — no React, no socket. Proves the avatar-stack roster
 * and per-cell index that the cloud grid renders: deterministic colors, dedup
 * across tabs, self-exclusion, and editing-wins-over-cursor cell indexing.
 */

import { describe, expect, it } from "vitest";
import type { GridPresenceState } from "@gtmgrid/services/realtime";
import {
  PRESENCE_COLORS,
  buildPresenceView,
  presenceCellKey,
  presenceColor,
} from "./gridPresence.js";

const state = (over: Partial<GridPresenceState> = {}): GridPresenceState => ({
  userId: "u1",
  ...over,
});

describe("presenceColor", () => {
  it("is deterministic and drawn from the palette", () => {
    expect(presenceColor("user_abc")).toBe(presenceColor("user_abc"));
    expect(PRESENCE_COLORS).toContain(presenceColor("user_abc"));
  });

  it("spreads distinct ids across more than one hue", () => {
    const hues = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map(presenceColor),
    );
    expect(hues.size).toBeGreaterThan(1);
  });
});

describe("buildPresenceView", () => {
  it("excludes the local user", () => {
    const view = buildPresenceView(
      [state({ userId: "me" }), state({ userId: "them" })],
      "me",
    );
    expect(view.users.map((u) => u.userId)).toEqual(["them"]);
  });

  it("dedups one user across tabs, preferring the connection with a cursor", () => {
    const view = buildPresenceView(
      [
        state({ userId: "u1", connectionId: "tab-idle" }),
        state({
          userId: "u1",
          connectionId: "tab-active",
          cursor: { rowId: "r1", columnId: "c1" },
        }),
      ],
      null,
    );
    expect(view.users).toHaveLength(1);
    expect(view.users[0].cursor).toEqual({ rowId: "r1", columnId: "c1" });
  });

  it("indexes a member by their cursor cell", () => {
    const view = buildPresenceView(
      [state({ userId: "u1", cursor: { rowId: "r2", columnId: "c3" } })],
      null,
    );
    const here = view.byCell.get(presenceCellKey("r2", "c3"));
    expect(here?.map((u) => u.userId)).toEqual(["u1"]);
    expect(here?.[0].editing).toBe(false);
  });

  it("lets editing win over cursor for the indexed cell", () => {
    const view = buildPresenceView(
      [
        state({
          userId: "u1",
          cursor: { rowId: "r1", columnId: "c1" },
          editing: { rowId: "r9", columnId: "c9" },
        }),
      ],
      null,
    );
    expect(view.byCell.has(presenceCellKey("r1", "c1"))).toBe(false);
    const editingCell = view.byCell.get(presenceCellKey("r9", "c9"));
    expect(editingCell?.[0].editing).toBe(true);
  });

  it("buckets multiple members on the same cell", () => {
    const cell = { rowId: "r1", columnId: "c1" };
    const view = buildPresenceView(
      [
        state({ userId: "u1", cursor: cell }),
        state({ userId: "u2", cursor: cell }),
      ],
      null,
    );
    expect(view.byCell.get(presenceCellKey("r1", "c1"))).toHaveLength(2);
  });

  it("tolerates states missing optional fields", () => {
    const view = buildPresenceView([state({ userId: "u1" })], null);
    expect(view.users[0]).toMatchObject({
      name: null,
      image: null,
      cursor: null,
      editing: false,
    });
    expect(view.byCell.size).toBe(0);
  });
});
