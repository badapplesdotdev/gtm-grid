/**
 * Pure presence-view tests — no React, no socket. Proves the avatar-stack roster
 * and per-cell index that the cloud grid renders: deterministic colors, dedup
 * across tabs, self-exclusion, and editing-wins-over-cursor cell indexing.
 */

import { describe, expect, it } from "vitest";
import type { GridPresenceState } from "@gtmgrid/services/realtime";
import {
  AGENT_PRESENCE_COLOR,
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
  it("includes the local user in the stack, flagged isSelf and sorted first", () => {
    const view = buildPresenceView(
      [state({ userId: "them" }), state({ userId: "me" })],
      "me",
    );
    expect(view.users.map((u) => u.userId)).toEqual(["me", "them"]);
    expect(view.users[0].isSelf).toBe(true);
    expect(view.users[1].isSelf).toBe(false);
  });

  it("excludes the local user from cell cursors (no ring on your own cell)", () => {
    const cell = { rowId: "r1", columnId: "c1" };
    const view = buildPresenceView(
      [state({ userId: "me", cursor: cell }), state({ userId: "them", cursor: cell })],
      "me",
    );
    const here = view.byCell.get(presenceCellKey("r1", "c1"));
    expect(here?.map((u) => u.userId)).toEqual(["them"]);
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
      isAgent: false,
      activity: null,
      column: null,
    });
    expect(view.byCell.size).toBe(0);
  });
});

describe("buildPresenceView — agent participants", () => {
  it("keeps a member and THEIR agent (same userId) as two participants", () => {
    const view = buildPresenceView(
      [
        state({ userId: "u1", name: "Morgan" }),
        state({ userId: "u1", agent: true, name: "Morgan's Agent" }),
      ],
      "u1",
    );
    expect(view.users).toHaveLength(2);
    const keys = view.users.map((u) => u.key).sort();
    expect(keys).toEqual(["u1", "u1:agent"]);
  });

  it("paints agents with the fixed accent color, not the hashed hue", () => {
    const view = buildPresenceView([state({ userId: "u1", agent: true })], null);
    expect(view.users[0].color).toBe(AGENT_PRESENCE_COLOR);
    expect(view.users[0].isAgent).toBe(true);
  });

  it("your own agent is never self — its cursor rings YOUR grid too", () => {
    const cell = { rowId: "r1", columnId: "c1" };
    const view = buildPresenceView(
      [state({ userId: "u1", agent: true, editing: cell })],
      "u1",
    );
    expect(view.users[0].isSelf).toBe(false);
    expect(view.byCell.get(presenceCellKey("r1", "c1"))).toHaveLength(1);
  });

  it("indexes a column-scoped agent into byColumn with its activity", () => {
    const view = buildPresenceView(
      [state({ userId: "u1", agent: true, column: "col-9", activity: "running Email" })],
      "u1",
    );
    expect(view.byColumn.get("col-9")?.[0]).toMatchObject({
      isAgent: true,
      activity: "running Email",
    });
    expect(view.byCell.size).toBe(0);
  });

  it("sorts self first, then agents, then other members", () => {
    const view = buildPresenceView(
      [
        state({ userId: "u2", name: "Teammate" }),
        state({ userId: "u1", agent: true }),
        state({ userId: "u1", name: "Morgan" }),
      ],
      "u1",
    );
    expect(view.users.map((u) => u.key)).toEqual(["u1", "u1:agent", "u2"]);
  });
});
