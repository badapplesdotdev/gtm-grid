/**
 * The `grid` PartyKit party (TRI-3261) — the SERVER-GATED realtime provider that
 * replaces Supabase Realtime and fixes the cross-tenant leak.
 *
 * Room id = `${workspaceId}:${tableId}` (one room per workspace+table). Three
 * responsibilities:
 *
 *   1. `onBeforeConnect` (AUTHORIZATION — the fix): read `?token=`, verify it
 *      (HS256, `PARTY_AUTH_SECRET`) and REJECT unless the token's `workspaceId`
 *      equals the room's workspace AND it is unexpired. The decision is the PURE
 *      `authorizeGridConnection` (unit-tested in `@gtmgrid/auth`); a non-member's
 *      socket is closed before it can receive any event.
 *   2. `onRequest` (SERVER PUBLISH): require `Authorization: Bearer
 *      PARTY_PUBLISH_SECRET`, then `room.broadcast` the posted `GridChangeEvent`
 *      to every connected (already-authorized) client.
 *   3. PRESENCE: derive each connection's `userId` from its token, and broadcast
 *      the roster on join/leave so members see who's-editing.
 *
 * The wire protocol matches the client (`@gtmgrid/services` `subscribeToGrid`):
 *   - grid change  → `{ kind: "grid", event }`
 *   - presence     → `{ kind: "presence", states }`
 *   - client→server presence update → `{ kind: "presence", state }`
 */

import type * as Party from "partykit/server";
import {
  authorizeGridConnection,
  isAuthorizedPublish,
  tokenFromUrl,
} from "./auth";
import type {
  GridChangeEvent,
  GridPresenceState,
} from "@gtmgrid/services/realtime";

/** The per-connection state we attach (the presence identity from the token). */
interface ConnState {
  readonly userId: string;
  /** This connection's last-published presence (cursor/editing), if any. */
  presence?: GridPresenceState;
}

/** A connection carrying our {@link ConnState}. */
type GridConn = Party.Connection<ConnState>;

export default class GridServer implements Party.Server {
  constructor(readonly room: Party.Room) {}

  /**
   * AUTHORIZE the socket before it joins the room. Verifies the `?token=` and
   * matches its `workspaceId` to the room; rejecting returns a 401 so the client
   * socket never opens. Stashes the resolved `userId` on the request (via a
   * header) for {@link onConnect} to read as presence identity.
   */
  static async onBeforeConnect(
    request: Party.Request,
    lobby: Party.Lobby,
  ): Promise<Party.Request | Response> {
    const secret = lobby.env.PARTY_AUTH_SECRET as string | undefined;
    if (!secret) {
      return new Response("party auth not configured", { status: 503 });
    }
    const decision = await authorizeGridConnection({
      token: tokenFromUrl(request.url),
      roomId: lobby.id,
      secret,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!decision.ok) {
      return new Response(`unauthorized: ${decision.reason}`, { status: 401 });
    }
    // Pass the authorized user id to onConnect (request state is not shared).
    request.headers.set("x-gtmgrid-user", decision.claims.sub);
    return request;
  }

  /** Track the joined connection's presence identity and broadcast the roster. */
  onConnect(conn: GridConn, ctx: Party.ConnectionContext): void {
    const userId = ctx.request.headers.get("x-gtmgrid-user") ?? "";
    conn.setState({ userId });
    this.broadcastPresence();
  }

  /** A presence update from a client → store it and re-broadcast the roster. */
  onMessage(message: string, sender: GridConn): void {
    let parsed: { kind?: unknown; state?: unknown };
    try {
      parsed = JSON.parse(message) as { kind?: unknown; state?: unknown };
    } catch {
      return;
    }
    if (parsed.kind !== "presence" || typeof parsed.state !== "object") return;
    const prev = sender.state;
    if (prev) {
      sender.setState({ ...prev, presence: parsed.state as GridPresenceState });
    }
    this.broadcastPresence();
  }

  /** Re-broadcast the roster when a member leaves. */
  onClose(): void {
    this.broadcastPresence();
  }

  /**
   * SERVER PUBLISH: the only way a grid change enters the room. The
   * `RealtimePublisher` Live layer POSTs the event here with the server bearer;
   * we authorize it then broadcast to connected clients. No bearer → 401.
   */
  async onRequest(req: Party.Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const secret = this.room.env.PARTY_PUBLISH_SECRET as string | undefined;
    if (!isAuthorizedPublish(req.headers.get("Authorization"), secret)) {
      return new Response("unauthorized", { status: 401 });
    }
    let event: GridChangeEvent;
    try {
      event = (await req.json()) as GridChangeEvent;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    this.room.broadcast(JSON.stringify({ kind: "grid", event }));
    return new Response("ok", { status: 200 });
  }

  /** Broadcast the current presence roster (the non-empty states) to everyone. */
  private broadcastPresence(): void {
    const states: GridPresenceState[] = [];
    for (const conn of this.room.getConnections<ConnState>()) {
      const presence = conn.state?.presence;
      if (presence) states.push(presence);
    }
    this.room.broadcast(JSON.stringify({ kind: "presence", states }));
  }
}
