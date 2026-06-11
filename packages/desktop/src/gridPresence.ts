/**
 * Pure presence helpers for the cloud multiplayer grid (avatar stack + cursors).
 *
 * The PartyKit grid party broadcasts the full roster of {@link GridPresenceState}
 * on every join/leave/cursor-move (see `apps/party/src/server.ts`). This module
 * turns that raw roster into the two render-ready shapes the grid needs — the
 * deduped, self-excluded {@link PresenceUser} list (for the toolbar avatar stack)
 * and a `byCell` index (for the per-cell rings/chips) — without touching React or
 * the DOM, so the math is unit-testable in isolation and the shared `DataGrid`
 * can import it without reaching into `cloud/`.
 *
 * Colors are derived here, client-side, from a deterministic hash of the userId —
 * never sent over the wire — so every client paints the same user the same hue.
 */

import type {
  GridPresenceCell,
  GridPresenceState,
} from "@gtmgrid/services/realtime";

/** A remote member resolved for rendering (one row in the avatar stack). */
export interface PresenceUser {
  readonly userId: string;
  readonly name: string | null;
  readonly image: string | null;
  /** Deterministic hue derived from `userId` (ring + avatar accent). */
  readonly color: string;
  /** The cell the member has selected, if any (drives the colored ring). */
  readonly cursor: GridPresenceCell | null;
  /** True when the member is actively editing their cursor cell. */
  readonly editing: boolean;
}

/** What the grid renders: the deduped roster + a per-cell lookup. */
export interface GridPresenceView {
  /** Deduped by userId, self excluded — the toolbar avatar stack. */
  readonly users: readonly PresenceUser[];
  /** `${rowId}:${columnId}` → the members whose cursor/edit is on that cell. */
  readonly byCell: ReadonlyMap<string, readonly PresenceUser[]>;
}

/**
 * The presence palette — eight high-contrast hues that read on both the light
 * and dark grid surfaces. Indexed by a hash of the userId.
 */
export const PRESENCE_COLORS: readonly string[] = [
  "#e8590c", // orange
  "#1c7ed6", // blue
  "#2f9e44", // green
  "#ae3ec9", // purple
  "#e64980", // pink
  "#0c8599", // teal
  "#f08c00", // amber
  "#4263eb", // indigo
];

/** The key under which a cell's presence is indexed in {@link GridPresenceView}. */
export const presenceCellKey = (rowId: string, columnId: string): string =>
  `${rowId}:${columnId}`;

/**
 * Deterministically map a userId to a palette color via a djb2 hash, so the same
 * member is always the same hue across clients and reloads.
 */
export const presenceColor = (userId: string): string => {
  let hash = 5381;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 33) ^ userId.charCodeAt(i);
  }
  const index = Math.abs(hash) % PRESENCE_COLORS.length;
  return PRESENCE_COLORS[index];
};

/** The cell a member is "on": editing takes precedence over a plain cursor. */
const activeCell = (state: GridPresenceState): GridPresenceCell | null =>
  state.editing ?? state.cursor ?? null;

/**
 * Build the render-ready {@link GridPresenceView} from a raw roster.
 *
 * - Drops the local user (`selfUserId`) — you don't follow your own cursor.
 * - Dedups by userId (a member open in multiple tabs appears once), preferring
 *   the connection that has a cursor so an idle background tab can't blank out an
 *   active one.
 * - Indexes each remaining member by their active cell so the grid can decorate
 *   cells in O(1); `editing` wins over `cursor` when both are present.
 */
export const buildPresenceView = (
  states: readonly GridPresenceState[],
  selfUserId: string | null,
): GridPresenceView => {
  // Dedup by userId, preferring a state that carries a cursor/edit position.
  const byUser = new Map<string, GridPresenceState>();
  for (const state of states) {
    if (state.userId === selfUserId) continue;
    const existing = byUser.get(state.userId);
    if (existing === undefined || (activeCell(existing) === null && activeCell(state) !== null)) {
      byUser.set(state.userId, state);
    }
  }

  const users: PresenceUser[] = [];
  const byCell = new Map<string, PresenceUser[]>();
  for (const state of byUser.values()) {
    const cell = activeCell(state);
    const user: PresenceUser = {
      userId: state.userId,
      name: state.name ?? null,
      image: state.image ?? null,
      color: presenceColor(state.userId),
      cursor: cell,
      editing: state.editing != null,
    };
    users.push(user);
    if (cell !== null) {
      const key = presenceCellKey(cell.rowId, cell.columnId);
      const bucket = byCell.get(key);
      if (bucket === undefined) byCell.set(key, [user]);
      else bucket.push(user);
    }
  }

  return { users, byCell };
};
