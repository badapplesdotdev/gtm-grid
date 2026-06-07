/**
 * `RealtimePublisher` unit tests (TRI-3251) — OFFLINE.
 *
 * Proves the recording Test Layer captures published events (the seam grid
 * mutations are asserted against), the no-op layer swallows them, and the env
 * config resolver degrades gracefully when Supabase is unconfigured.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  noopRealtimePublisherLayer,
  RealtimePublisher,
  realtimePublisherConfigFromEnv,
  type RecordedGridEvent,
  recordingRealtimePublisherLayer,
} from "./realtime-publisher.js";

const publish = (workspaceId: string, tableId: string) =>
  Effect.flatMap(RealtimePublisher, (p) =>
    p.publish({
      workspaceId,
      tableId,
      event: {
        type: "cell.upsert",
        cell: { rowId: "r1", columnId: "c1", value: "v", status: "done", error: null },
      },
    }),
  );

describe("recordingRealtimePublisherLayer", () => {
  it("records each published event with its routing keys", async () => {
    const recorded: RecordedGridEvent[] = [];
    await Effect.runPromise(
      publish("ws-1", "t-1").pipe(
        Effect.provide(recordingRealtimePublisherLayer(recorded)),
      ),
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ workspaceId: "ws-1", tableId: "t-1" });
    expect(recorded[0].event.type).toBe("cell.upsert");
  });
});

describe("noopRealtimePublisherLayer", () => {
  it("swallows events without throwing", async () => {
    await expect(
      Effect.runPromise(
        publish("ws-1", "t-1").pipe(
          Effect.provide(noopRealtimePublisherLayer()),
        ),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("realtimePublisherConfigFromEnv", () => {
  it("resolves config from SUPABASE_URL + service role key", () => {
    expect(
      realtimePublisherConfigFromEnv({
        SUPABASE_URL: "https://x.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "secret",
      }),
    ).toEqual({ url: "https://x.supabase.co", key: "secret" });
  });

  it("returns null when either var is missing", () => {
    expect(realtimePublisherConfigFromEnv({ SUPABASE_URL: "x" })).toBeNull();
    expect(realtimePublisherConfigFromEnv({})).toBeNull();
  });
});
