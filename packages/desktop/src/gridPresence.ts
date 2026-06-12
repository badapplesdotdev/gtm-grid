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

/** A member resolved for rendering (one row in the avatar stack). */
export interface PresenceUser {
  readonly userId: string;
  /**
   * Render identity — `userId` for a member, `${userId}:agent` for that
   * member's AI agent. Use as the React key everywhere a roster maps to
   * elements: a member and their agent share a `userId`.
   */
  readonly key: string;
  readonly name: string | null;
  readonly image: string | null;
  /** Deterministic hue derived from `userId` (ring + avatar accent). */
  readonly color: string;
  /** The cell the member has selected, if any (drives the colored ring). */
  readonly cursor: GridPresenceCell | null;
  /** True when the member is actively editing their cursor cell. */
  readonly editing: boolean;
  /** True for the local user (shown in the stack as "you", not followable). */
  readonly isSelf: boolean;
  /** True for an AI-agent participant (bot glyph, fixed accent color). */
  readonly isAgent: boolean;
  /** The agent's activity label ("adding 5 rows"), shown in tooltips. */
  readonly activity: string | null;
  /** Column the agent is working over (column-header ring), if any. */
  readonly column: string | null;
}

/** What the grid renders: the deduped roster + per-cell / per-column lookups. */
export interface GridPresenceView {
  /** Deduped by userId, the local user first — the toolbar avatar stack. */
  readonly users: readonly PresenceUser[];
  /**
   * `${rowId}:${columnId}` → the OTHER members whose cursor/edit is on that cell.
   * The local user is excluded so your own selection isn't decorated as a remote
   * cursor.
   */
  readonly byCell: ReadonlyMap<string, readonly PresenceUser[]>;
  /** `columnId` → participants working over that column (column-header ring). */
  readonly byColumn: ReadonlyMap<string, readonly PresenceUser[]>;
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
 * The agent's ring/avatar color: the BRAND ACCENT, fixed (never hashed) so the
 * agent is instantly distinguishable from humans and tracks the active theme +
 * accent preset (`--accent` flips for dark mode automatically).
 */
export const AGENT_PRESENCE_COLOR = "var(--accent)";

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
 * - Includes the local user (`selfUserId`) in the avatar stack — flagged
 *   `isSelf` and sorted first — so you always see you're connected.
 * - Dedups by userId (a member open in multiple tabs appears once), preferring
 *   the connection that has a cursor so an idle background tab can't blank out an
 *   active one.
 * - Indexes each member by their active cell so the grid can decorate cells in
 *   O(1) (`editing` wins over `cursor`), but EXCLUDES the local user so your own
 *   selection isn't drawn as a remote cursor.
 */
export const buildPresenceView = (
  states: readonly GridPresenceState[],
  selfUserId: string | null,
): GridPresenceView => {
  // Dedup by render identity, preferring a state that carries a cursor/edit
  // position. An AGENT state keys as `${userId}:agent` — it shares the driving
  // member's token-stamped userId, and plain userId dedup would collapse the
  // agent into the human avatar.
  const renderKey = (state: GridPresenceState): string =>
    state.agent === true ? `${state.userId}:agent` : state.userId;
  const byUser = new Map<string, GridPresenceState>();
  for (const state of states) {
    const key = renderKey(state);
    const existing = byUser.get(key);
    if (existing === undefined || (activeCell(existing) === null && activeCell(state) !== null)) {
      byUser.set(key, state);
    }
  }

  const users: PresenceUser[] = [];
  const byCell = new Map<string, PresenceUser[]>();
  const byColumn = new Map<string, PresenceUser[]>();
  for (const [key, state] of byUser.entries()) {
    const cell = activeCell(state);
    const isAgent = state.agent === true;
    // Your own AGENT is never "self": its rings/chips should decorate YOUR
    // grid too — that is the whole Co-Pilot point.
    const isSelf = !isAgent && state.userId === selfUserId;
    const user: PresenceUser = {
      userId: state.userId,
      key,
      name: state.name ?? null,
      image: state.image ?? null,
      color: isAgent ? AGENT_PRESENCE_COLOR : presenceColor(state.userId),
      cursor: cell,
      editing: state.editing != null,
      isSelf,
      isAgent,
      activity: state.activity ?? null,
      column: state.column ?? null,
    };
    users.push(user);
    // Only OTHER participants decorate cells — never ring your own selection.
    if (cell !== null && !isSelf) {
      const cellKey = presenceCellKey(cell.rowId, cell.columnId);
      const bucket = byCell.get(cellKey);
      if (bucket === undefined) byCell.set(cellKey, [user]);
      else bucket.push(user);
    }
    if (user.column !== null && !isSelf) {
      const bucket = byColumn.get(user.column);
      if (bucket === undefined) byColumn.set(user.column, [user]);
      else bucket.push(user);
    }
  }

  // Local user first, then agents, then other members.
  const rank = (u: PresenceUser): number => (u.isSelf ? 0 : u.isAgent ? 1 : 2);
  users.sort((a, b) => rank(a) - rank(b));

  return { users, byCell, byColumn };
};
