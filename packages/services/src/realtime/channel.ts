/**
 * The thin PartyKit grid-room subscriber — the framework-agnostic client wrapper
 * that connects to the server-gated grid party, turns inbound messages into typed
 * {@link GridChangeEvent}s, and tracks presence (who's-editing / cursors).
 *
 * It is deliberately small and React-free: W4 wires it into `useCloudGrid` by
 * feeding each event through the pure reducer ({@link applyGridEvent}) to patch
 * the react-query `getTable` cache. Keeping the subscriber here (in
 * `@gtmgrid/services`, not apps/web) lets the desktop and any web client share
 * one definition.
 *
 * Auth model (server-gated, TRI-3261): the caller passes a WORKSPACE-SCOPED token
 * minted by the server (`realtime.token`, backed by `@gtmgrid/auth`
 * `mintPartyToken`) as the `?token=` query param. The party's `onBeforeConnect`
 * rejects the socket unless the token's `workspaceId` matches the room's, so a
 * non-member's connection is closed BEFORE it can receive any event — this is the
 * fix for the cross-tenant leak. All reads/writes still go through tRPC; the room
 * carries only broadcast change events + presence.
 */

import PartySocket from "partysocket";
import type { GridChangeEvent } from "./events.js";

/**
 * The wire protocol the grid party broadcasts to connected clients. A grid change
 * carries a {@link GridChangeEvent}; a presence message carries the full roster.
 * Discriminated on `kind` so the client handler is exhaustive.
 */
export type GridPartyMessage =
  | { readonly kind: "grid"; readonly event: GridChangeEvent }
  | { readonly kind: "presence"; readonly states: readonly GridPresenceState[] };

/** A presence update the client sends UP to the party (its current state). */
export interface GridPresenceUpdate {
  readonly kind: "presence";
  readonly state: GridPresenceState;
}

/** Presence state a member publishes (cursor / editing target). Extensible. */
export interface GridPresenceState {
  readonly userId: string;
  readonly name?: string | null;
  /** The cell the member is currently editing, if any. */
  readonly editing?: { readonly rowId: string; readonly columnId: string } | null;
}

/** Options for {@link subscribeToGrid}. */
export interface SubscribeToGridOptions {
  /** Base URL of the PartyKit deployment (e.g. `http://127.0.0.1:1999`). */
  readonly url: string;
  /** The server-minted WORKSPACE-SCOPED token for the current user. */
  readonly token: string;
  /** The workspace + table to subscribe to (scopes the party room). */
  readonly workspaceId: string;
  readonly tableId: string;
  /** Called for each inbound grid change event (feed into `applyGridEvent`). */
  readonly onEvent: (event: GridChangeEvent) => void;
  /** Called whenever presence state changes (the full roster). */
  readonly onPresence?: (states: readonly GridPresenceState[]) => void;
  /** This client's presence state to track on connect (who's-editing). */
  readonly presence?: GridPresenceState;
}

/** Handle returned by {@link subscribeToGrid} to update presence or tear down. */
export interface GridSubscription {
  /** Update this client's tracked presence (e.g. moved to a new cell). */
  readonly updatePresence: (state: GridPresenceState) => Promise<void>;
  /** Unsubscribe + close the socket connection. */
  readonly unsubscribe: () => Promise<void>;
}

/** Parse an inbound socket payload into a typed {@link GridPartyMessage}, or null. */
const parseMessage = (data: unknown): GridPartyMessage | null => {
  if (typeof data !== "string") return null;
  try {
    const msg = JSON.parse(data) as { kind?: unknown };
    if (msg.kind === "grid" || msg.kind === "presence") {
      return msg as GridPartyMessage;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Subscribe to a table's grid party room: receive broadcast change events and
 * track presence. Returns a {@link GridSubscription} for presence updates +
 * teardown.
 *
 * `partysocket` auto-reconnects and re-sends the connect query (the token) on a
 * dropped connection, so transient network blips recover without caller logic;
 * the caller should re-seed its snapshot via a tRPC `getTable` read after a long
 * outage (broadcast is not replayed). The room is `${workspaceId}:${tableId}` and
 * the party is `grid` — matching the server publish endpoint.
 */
export const subscribeToGrid = (
  options: SubscribeToGridOptions,
): GridSubscription => {
  const socket = new PartySocket({
    host: options.url,
    party: "grid",
    room: `${options.workspaceId}:${options.tableId}`,
    query: { token: options.token },
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    const msg = parseMessage(event.data);
    if (msg === null) return;
    if (msg.kind === "grid") {
      options.onEvent(msg.event);
    } else if (msg.kind === "presence") {
      options.onPresence?.(msg.states);
    }
  });

  const sendPresence = (state: GridPresenceState): void => {
    const update: GridPresenceUpdate = { kind: "presence", state };
    socket.send(JSON.stringify(update));
  };

  if (options.presence) {
    const initial = options.presence;
    socket.addEventListener("open", () => sendPresence(initial), { once: true });
  }

  return {
    updatePresence: async (state) => {
      sendPresence(state);
    },
    unsubscribe: async () => {
      socket.close();
    },
  };
};
