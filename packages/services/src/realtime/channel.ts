/**
 * The thin Supabase Realtime channel subscriber — the framework-agnostic client
 * wrapper that turns inbound Broadcast messages into typed
 * {@link GridChangeEvent}s and tracks Presence (who's-editing / cursors).
 *
 * It is deliberately small and React-free: W4 wires it into `useCloudGrid` by
 * feeding each event through the pure reducer ({@link applyGridEvent}) to patch
 * the react-query `getTable` cache. Keeping the subscriber here (in
 * `@gtmgrid/services`, not apps/web) lets the desktop and any web client share
 * one definition.
 *
 * Auth model (no RLS): the caller passes a Supabase-compatible JWT minted by the
 * server (`realtime.token`, backed by `@gtmgrid/auth` `mintSupabaseJwt`). The JWT
 * authorizes the Realtime CONNECTION; all reads/writes still go through tRPC.
 * Broadcast is used for change events; Presence for live member state.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  type GridChangeEvent,
  GRID_EVENT_NAME,
  gridChannelName,
} from "./events.js";

/** Presence state a member publishes (cursor / editing target). Extensible. */
export interface GridPresenceState {
  readonly userId: string;
  readonly name?: string | null;
  /** The cell the member is currently editing, if any. */
  readonly editing?: { readonly rowId: string; readonly columnId: string } | null;
}

/** Options for {@link subscribeToGrid}. */
export interface SubscribeToGridOptions {
  /** Supabase project URL. */
  readonly url: string;
  /** The Supabase anon/publishable key (the JWT below authorizes the user). */
  readonly anonKey: string;
  /** The server-minted Supabase-compatible JWT for the current user. */
  readonly token: string;
  /** The workspace + table to subscribe to (scopes the channel name). */
  readonly workspaceId: string;
  readonly tableId: string;
  /** Called for each inbound grid change event (feed into `applyGridEvent`). */
  readonly onEvent: (event: GridChangeEvent) => void;
  /** Called whenever presence state changes (the full roster). */
  readonly onPresence?: (states: readonly GridPresenceState[]) => void;
  /** This client's presence state to track on subscribe (who's-editing). */
  readonly presence?: GridPresenceState;
}

/** Handle returned by {@link subscribeToGrid} to update presence or tear down. */
export interface GridSubscription {
  /** Update this client's tracked presence (e.g. moved to a new cell). */
  readonly updatePresence: (state: GridPresenceState) => Promise<void>;
  /** Unsubscribe + remove the channel + close the client connection. */
  readonly unsubscribe: () => Promise<void>;
}

/**
 * Subscribe to a table's grid channel: receive Broadcast change events and track
 * Presence. Returns a {@link GridSubscription} for presence updates + teardown.
 *
 * The Supabase realtime client auto-reconnects and re-subscribes the channel on a
 * dropped connection, so transient network blips recover without caller logic;
 * the caller should re-seed its snapshot via a tRPC `getTable` read after a long
 * outage (broadcast is not replayed).
 */
export const subscribeToGrid = (
  options: SubscribeToGridOptions,
): GridSubscription => {
  const client: SupabaseClient = createClient(options.url, options.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  // Authorize the realtime connection with the minted JWT (no RLS — the JWT
  // authorizes the socket; reads/writes still go through tRPC).
  client.realtime.setAuth(options.token);

  const channel = client.channel(
    gridChannelName(options.workspaceId, options.tableId),
    { config: { presence: { key: options.presence?.userId ?? "" } } },
  );

  channel.on("broadcast", { event: GRID_EVENT_NAME }, (message) => {
    options.onEvent(message.payload as GridChangeEvent);
  });

  if (options.onPresence) {
    const emit = () => {
      const raw = channel.presenceState<GridPresenceState>();
      const states = Object.values(raw).flat();
      options.onPresence?.(states);
    };
    channel.on("presence", { event: "sync" }, emit);
    channel.on("presence", { event: "join" }, emit);
    channel.on("presence", { event: "leave" }, emit);
  }

  channel.subscribe((status) => {
    if (status === "SUBSCRIBED" && options.presence) {
      void channel.track(options.presence);
    }
  });

  return {
    updatePresence: async (state) => {
      await channel.track(state);
    },
    unsubscribe: async () => {
      await client.removeChannel(channel);
    },
  };
};
