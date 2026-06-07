/**
 * `RealtimePublisher` — the INJECTABLE port that broadcasts grid change events to
 * connected clients, the server side of the Convex `useQuery` live-reactivity
 * replacement (TRI-3251), reimplemented over a SERVER-GATED PartyKit provider
 * (TRI-3261).
 *
 * After a successful grid write, `GridService` calls {@link RealtimePublisher}'s
 * `publish` with the owning workspace + table + a typed {@link GridChangeEvent}.
 * Every other client subscribed to that table's party room receives the event and
 * applies it to its cached snapshot via the pure reducer (`realtime/reducer.ts`),
 * so the grid stays live with NO refetch and NO Postgres-Changes/CDC.
 *
 * Two Layers, the same pattern as {@link MeterService}:
 *   - {@link realtimePublisherLayer} — the LIVE publisher. Server-publishes by
 *     HTTP POSTing the event to the grid party's `onRequest` endpoint
 *     (`${PARTY_URL}/parties/grid/${workspaceId}:${tableId}`) with
 *     `Authorization: Bearer PARTY_PUBLISH_SECRET`. The party then broadcasts the
 *     event to its connected (authorized) clients. Best-effort: a transport error
 *     is swallowed so a realtime hiccup never fails the user's grid write (the
 *     write already succeeded; tRPC reads remain the source of truth).
 *   - {@link recordingRealtimePublisherLayer} — the TEST Layer that RECORDS every
 *     published event into a shared array, so `GridService` mutations can be
 *     unit-tested offline (assert "this write published this event") with no
 *     network, no DB.
 *   - {@link noopRealtimePublisherLayer} — the deployment-safe fallback when the
 *     PartyKit env is not configured (swallows every event).
 *
 * Making the publisher a port (not a direct provider call inside the service)
 * keeps `GridService` fully offline-testable and lets the transport be swapped
 * without touching the service. The SERVER publish authenticates with
 * `PARTY_PUBLISH_SECRET` (a server-only bearer), NOT a per-user token — the
 * client subscription is what is server-gated per workspace (see the party's
 * `onBeforeConnect`).
 */

import { Context, Data, Effect, Layer } from "effect";
import type { GridChangeEvent } from "../realtime/events.js";

/** Raised when a publish fails (PartyKit transport/config error). */
export class RealtimePublisherError extends Data.TaggedError(
  "RealtimePublisherError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A published-event record the TEST Layer captures, carrying the routing keys so
 * a test can assert BOTH the room scope and the payload.
 */
export interface RecordedGridEvent {
  readonly workspaceId: string;
  readonly tableId: string;
  readonly event: GridChangeEvent;
}

/** The realtime broadcast port the grid mutations publish through. */
export class RealtimePublisher extends Context.Tag("RealtimePublisher")<
  RealtimePublisher,
  {
    /**
     * Broadcast a grid change event on the workspace+table room. Call AFTER a
     * successful write; the live implementation is best-effort and never fails
     * the surrounding write.
     */
    readonly publish: (args: {
      readonly workspaceId: string;
      readonly tableId: string;
      readonly event: GridChangeEvent;
    }) => Effect.Effect<void, RealtimePublisherError>;
  }
>() {}

/** Config for {@link realtimePublisherLayer}: the PartyKit URL + publish secret. */
export interface RealtimePublisherConfig {
  /** Base URL of the PartyKit deployment (e.g. `http://127.0.0.1:1999`). */
  readonly url: string;
  /**
   * The server-only bearer the party's `onRequest` requires to authorize a
   * server publish (`PARTY_PUBLISH_SECRET`). Never exposed to clients.
   */
  readonly publishSecret: string;
}

/**
 * Resolve the live config from the environment. Returns `null` when either var
 * is missing, so {@link realtimePublisherLayerFromEnv} can degrade to a no-op
 * publisher rather than crash a deployment that has not wired PartyKit yet.
 */
export const realtimePublisherConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): RealtimePublisherConfig | null => {
  const url = env.PARTY_URL;
  const publishSecret = env.PARTY_PUBLISH_SECRET;
  return url && publishSecret ? { url, publishSecret } : null;
};

/**
 * Build the server-publish endpoint URL for a workspace+table room: the grid
 * party's HTTP entrypoint (`onRequest`), keyed by the `${workspaceId}:${tableId}`
 * room id (matching the client's connect URL). `grid` is the PARTY name; the room
 * id is the workspace+table pair (NOT the `grid:`-prefixed channel name).
 */
export const partyPublishUrl = (
  baseUrl: string,
  workspaceId: string,
  tableId: string,
): string =>
  `${baseUrl.replace(/\/$/, "")}/parties/grid/${workspaceId}:${tableId}`;

/**
 * The live publisher. HTTP POSTs each event to the grid party's `onRequest`
 * endpoint with the server bearer; the party broadcasts it to connected clients.
 * `publish` is best-effort: a non-2xx response or a fetch rejection is mapped to
 * a typed error which the grid service ignores, so realtime never blocks a write.
 *
 * `fetchImpl` is injectable so the unit test can assert the exact URL + bearer
 * with a fake fetch (no network).
 */
export const realtimePublisherLayer = (
  config: RealtimePublisherConfig,
  fetchImpl: typeof fetch = fetch,
): Layer.Layer<RealtimePublisher> =>
  Layer.succeed(RealtimePublisher, {
    publish: (args) =>
      Effect.tryPromise({
        try: async () => {
          const res = await fetchImpl(
            partyPublishUrl(config.url, args.workspaceId, args.tableId),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${config.publishSecret}`,
              },
              body: JSON.stringify(args.event),
            },
          );
          if (!res.ok) {
            throw new Error(
              `party publish failed: ${res.status} ${res.statusText}`,
            );
          }
        },
        catch: (cause) =>
          new RealtimePublisherError({
            message:
              cause instanceof Error ? cause.message : "realtime publish failed",
            cause,
          }),
      }),
  });

/**
 * A no-op publisher — the deployment-safe fallback when PartyKit is not
 * configured (env vars absent). Swallows every event so grid writes still
 * succeed with no realtime fan-out.
 */
export const noopRealtimePublisherLayer = (): Layer.Layer<RealtimePublisher> =>
  Layer.succeed(RealtimePublisher, { publish: () => Effect.void });

/**
 * The LIVE publisher resolved from the environment, degrading to the no-op layer
 * when PartyKit is not configured. This is what {@link appLayer} wires.
 */
export const realtimePublisherLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
): Layer.Layer<RealtimePublisher> => {
  const config = realtimePublisherConfigFromEnv(env);
  return config ? realtimePublisherLayer(config) : noopRealtimePublisherLayer();
};

/**
 * The TEST Layer: RECORDS each published event into the supplied array (shared by
 * reference, so a test reads it back after running grid mutations) instead of
 * touching PartyKit. This is how `GridService` mutations are unit-tested offline.
 */
export const recordingRealtimePublisherLayer = (
  recorded: RecordedGridEvent[] = [],
): Layer.Layer<RealtimePublisher> =>
  Layer.succeed(RealtimePublisher, {
    publish: (args) =>
      Effect.sync(() => {
        recorded.push({
          workspaceId: args.workspaceId,
          tableId: args.tableId,
          event: args.event,
        });
      }),
  });
