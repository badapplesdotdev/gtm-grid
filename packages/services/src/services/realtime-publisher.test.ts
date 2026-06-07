/**
 * `RealtimePublisher` unit tests (TRI-3251 / TRI-3261) — OFFLINE.
 *
 * Proves the recording Test Layer captures published events (the seam grid
 * mutations are asserted against), the no-op layer swallows them, the env config
 * resolver degrades gracefully when PartyKit is unconfigured, and the LIVE layer
 * POSTs the event to the right party URL with the server bearer (fake fetch — no
 * network).
 */

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { GridChangeEvent } from "../realtime/events.js";
import {
  noopRealtimePublisherLayer,
  partyPublishUrl,
  RealtimePublisher,
  realtimePublisherConfigFromEnv,
  realtimePublisherLayer,
  type RecordedGridEvent,
  recordingRealtimePublisherLayer,
} from "./realtime-publisher.js";

const EVENT: GridChangeEvent = {
  type: "cell.upsert",
  cell: { rowId: "r1", columnId: "c1", value: "v", status: "done", error: null },
};

const publish = (workspaceId: string, tableId: string) =>
  Effect.flatMap(RealtimePublisher, (p) =>
    p.publish({ workspaceId, tableId, event: EVENT }),
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
  it("resolves config from PARTY_URL + PARTY_PUBLISH_SECRET", () => {
    expect(
      realtimePublisherConfigFromEnv({
        PARTY_URL: "http://127.0.0.1:1999",
        PARTY_PUBLISH_SECRET: "publish-secret",
      }),
    ).toEqual({ url: "http://127.0.0.1:1999", publishSecret: "publish-secret" });
  });

  it("returns null when either var is missing", () => {
    expect(
      realtimePublisherConfigFromEnv({ PARTY_URL: "http://x" }),
    ).toBeNull();
    expect(
      realtimePublisherConfigFromEnv({ PARTY_PUBLISH_SECRET: "s" }),
    ).toBeNull();
    expect(realtimePublisherConfigFromEnv({})).toBeNull();
  });
});

describe("partyPublishUrl", () => {
  it("builds /parties/grid/{workspaceId}:{tableId}, trimming a trailing slash", () => {
    expect(partyPublishUrl("http://127.0.0.1:1999", "ws-1", "t-1")).toBe(
      "http://127.0.0.1:1999/parties/grid/ws-1:t-1",
    );
    expect(partyPublishUrl("http://127.0.0.1:1999/", "ws-1", "t-1")).toBe(
      "http://127.0.0.1:1999/parties/grid/ws-1:t-1",
    );
  });
});

describe("realtimePublisherLayer (live, fake fetch)", () => {
  it("POSTs the event to the party room URL with the server bearer", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    await Effect.runPromise(
      publish("ws-1", "t-1").pipe(
        Effect.provide(
          realtimePublisherLayer(
            { url: "http://127.0.0.1:1999", publishSecret: "sek" },
            fetchImpl,
          ),
        ),
      ),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:1999/parties/grid/ws-1:t-1");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sek");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual(EVENT);
  });

  it("is best-effort: a non-2xx response fails with RealtimePublisherError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401, statusText: "Unauthorized" }));
    const exit = await Effect.runPromiseExit(
      publish("ws-1", "t-1").pipe(
        Effect.provide(
          realtimePublisherLayer(
            { url: "http://127.0.0.1:1999", publishSecret: "wrong" },
            fetchImpl,
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("maps a fetch rejection to RealtimePublisherError (never throws raw)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("ECONNREFUSED"));
    const exit = await Effect.runPromiseExit(
      publish("ws-1", "t-1").pipe(
        Effect.provide(
          realtimePublisherLayer(
            { url: "http://127.0.0.1:1999", publishSecret: "sek" },
            fetchImpl,
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});
