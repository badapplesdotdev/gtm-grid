/**
 * The agent's OWN presence connection to the grid party — a second websocket
 * alongside the human's (`useGridRealtime`), so the agent appears in the room
 * roster as its own participant ("<User>'s Agent", bot glyph, accent ring)
 * visible to EVERYONE in the room, not just the driving user.
 *
 * Deliberately separate from `gridPresenceStore`: that store carries exactly
 * one publisher — the human cursor's socket — and reusing it would clobber the
 * user's own presence. The party stamps the token's userId on every state, so
 * the agent shares the member's `userId`; the `agent: true` flag is what keeps
 * it a distinct participant in `buildPresenceView`.
 *
 * Lifecycle: lazily connects on the first published patch of a turn, clears
 * its state BEFORE closing on turn end (the channel re-sends `lastState` on
 * reconnect — a zombie reconnect must not resurrect a stale ring), and
 * re-mints the token each turn (sidesteps the 1h TTL).
 */

import { useCallback, useEffect, useRef } from "react";
import { subscribeToGrid, type GridSubscription } from "@gtmgrid/services/realtime";
import { mintRealtimeToken, PARTY_URL } from "./useCloudGrid";
import { useMe } from "./auth";
import {
  mapToolToPresence,
  type AgentPresencePatch,
  type AgentPresenceTableContext,
} from "./agentToolPresence";

/** Where (and as whom) the agent publishes presence. */
export interface AgentPresenceContext {
  readonly workspaceId: string;
  readonly tableId: string;
  /** The driving member's user id (the party stamps this anyway). */
  readonly userId: string;
  /** The driving member's display name → "<name>'s Agent". */
  readonly userName: string | null;
}

/** Trailing-throttle window for presence sends (mirrors the human cursor's). */
const PUBLISH_THROTTLE_MS = 120;

const agentLabel = (userName: string | null): string =>
  userName === null || userName.trim() === "" ? "Agent" : `${userName.split(" ")[0]}'s Agent`;

/**
 * One controller instance per open cloud table (owned by `useAgentPresence`).
 * `publish` may be called before the socket exists — it lazily connects.
 */
export class AgentPresenceController {
  private sub: GridSubscription | null = null;
  private connecting: Promise<GridSubscription | null> | null = null;
  private disposed = false;
  private pending: AgentPresencePatch | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ctx: AgentPresenceContext) {}

  /** Publish the agent's current activity (throttled, lazily connecting). */
  publish(patch: AgentPresencePatch): void {
    if (this.disposed) return;
    this.pending = patch;
    if (this.timer !== null) return; // trailing send already scheduled
    this.timer = setTimeout(() => {
      this.timer = null;
      const next = this.pending;
      this.pending = null;
      if (next !== null) void this.send(next);
    }, PUBLISH_THROTTLE_MS);
  }

  /** Clear the agent's presence then close — called when the turn finishes. */
  async endTurn(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    const sub = this.sub ?? (await this.connecting) ?? null;
    if (sub !== null) {
      // Clear BEFORE close so a partysocket reconnect can't replay the stale
      // ring (the channel re-sends lastState on every `open`).
      await sub
        .updatePresence(this.state({ cursor: null, editing: null, column: null, activity: "" }))
        .catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    this.sub = null;
    this.connecting = null;
  }

  /** Tear down without ceremony (table switch / unmount). */
  dispose(): void {
    this.disposed = true;
    void this.endTurn();
  }

  private state(patch: AgentPresencePatch) {
    return {
      userId: this.ctx.userId,
      agent: true,
      name: agentLabel(this.ctx.userName),
      image: null,
      cursor: patch.cursor,
      editing: patch.editing,
      column: patch.column,
      activity: patch.activity === "" ? null : patch.activity,
    };
  }

  private async send(patch: AgentPresencePatch): Promise<void> {
    const sub = await this.connect();
    if (sub === null || this.disposed) return;
    await sub.updatePresence(this.state(patch)).catch(() => {});
  }

  private connect(): Promise<GridSubscription | null> {
    if (this.sub !== null) return Promise.resolve(this.sub);
    if (this.connecting !== null) return this.connecting;
    this.connecting = (async () => {
      if (PARTY_URL === undefined) return null;
      try {
        const token = await mintRealtimeToken(this.ctx.workspaceId);
        if (this.disposed) return null;
        const sub = subscribeToGrid({
          url: PARTY_URL,
          token,
          workspaceId: this.ctx.workspaceId,
          tableId: this.ctx.tableId,
          // The human's socket already feeds the grid cache + presence store —
          // this connection only SPEAKS, double-feeding would duplicate.
          onEvent: () => {},
        });
        this.sub = sub;
        return sub;
      } catch {
        // Best-effort: presence must never break the agent turn.
        return null;
      }
    })();
    return this.connecting;
  }
}

// ── Open-table context + the App-level hook ─────────────────────────────────

/** The open cloud table the tool mapper resolves names against. */
export interface AgentPresenceOpenTable extends AgentPresenceTableContext {
  readonly tableId: string;
}

// CloudGrid publishes the open table here each render (module-level like
// gridPresenceStore — one cloud table open at a time); the agent-event handler
// reads it AT EVENT TIME, so App never re-renders for it.
let openTable: AgentPresenceOpenTable | null = null;

/** Publish (or clear) the open cloud table for agent-presence name resolution. */
export const setAgentPresenceTable = (table: AgentPresenceOpenTable | null): void => {
  openTable = table;
};

/** A tool/turn event forwarded from the agent panel's SSE stream. */
export type AgentPresenceEvent =
  | { readonly type: "tool"; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly type: "turn-end" };

/**
 * App-level hook: returns the `onAgentEvent` callback for `AgentPanel`. Owns
 * one {@link AgentPresenceController} per agent turn — created lazily on the
 * first mapped tool call, ended (clear + close) on turn end, disposed when the
 * cloud table switches or cloud mode turns off. Cloud-only: no-ops without a
 * cloud context.
 */
export function useAgentPresence(
  cloud: { readonly workspaceId: string; readonly tableId: string } | null,
): (e: AgentPresenceEvent) => void {
  const me = useMe();
  const controllerRef = useRef<AgentPresenceController | null>(null);
  const workspaceId = cloud?.workspaceId ?? null;
  const tableId = cloud?.tableId ?? null;
  const userId = me?.user._id ?? null;
  const userName = me?.user.name ?? null;

  // Table switch / cloud off / unmount → drop any live presence immediately.
  useEffect(
    () => () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    },
    [workspaceId, tableId],
  );

  return useCallback(
    (e: AgentPresenceEvent) => {
      if (workspaceId === null || tableId === null || userId === null) return;
      if (e.type === "turn-end") {
        const controller = controllerRef.current;
        controllerRef.current = null;
        void controller?.endTurn();
        return;
      }
      // Resolve against the OPEN table only — the presence room is per-table.
      const table = openTable;
      if (table === null || table.tableId !== tableId) return;
      const patch = mapToolToPresence(e, table);
      if (patch === null) return;
      controllerRef.current ??= new AgentPresenceController({
        workspaceId,
        tableId,
        userId,
        userName,
      });
      controllerRef.current.publish(patch);
    },
    [workspaceId, tableId, userId, userName],
  );
}
