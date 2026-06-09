/**
 * `WebhookDeliveryRepo` (in-memory) tests — focused on KEYSET pagination, the
 * AC-named replacement for the Convex cursor paginator. Asserts page ordering
 * (newest first), seek-past-cursor continuity (no gaps/overlaps), a stable
 * `(receivedAt, id)` tie-break, and the prune insert/delete round-trip.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  type WebhookDelivery,
  WebhookDeliveryRepo,
  webhookDeliveryRepoLayer,
} from "./webhook-delivery-repo.js";

const mk = (id: string, receivedAt: number): WebhookDelivery => ({
  id,
  workspaceId: "ws",
  webhookId: "wh",
  tableId: "tbl",
  status: 200,
  rowsAffected: 1,
  mode: "create",
  recordId: null,
  error: null,
  receivedAt,
});

const run = <A>(
  deliveries: WebhookDelivery[],
  program: (
    repo: typeof WebhookDeliveryRepo.Service,
  ) => Effect.Effect<A, unknown, never>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* WebhookDeliveryRepo;
      return yield* program(repo);
    }).pipe(Effect.provide(webhookDeliveryRepoLayer(deliveries))),
  );

describe("WebhookDeliveryRepo keyset pagination", () => {
  it("returns the first page newest-first with a next cursor", async () => {
    const rows = [mk("a", 1), mk("b", 2), mk("c", 3), mk("d", 4), mk("e", 5)];
    const page = await run([...rows], (r) =>
      r.listKeysetByWebhook({ webhookId: "wh", limit: 2, cursor: null }),
    );
    expect(page.items.map((d) => d.id)).toEqual(["e", "d"]);
    expect(page.nextCursor).toEqual({ receivedAt: 4, id: "d" });
  });

  it("pages through with no gaps or overlaps via the cursor", async () => {
    const rows = [mk("a", 1), mk("b", 2), mk("c", 3), mk("d", 4), mk("e", 5)];
    const layerRows = [...rows];
    const p1 = await run(layerRows, (r) =>
      r.listKeysetByWebhook({ webhookId: "wh", limit: 2, cursor: null }),
    );
    const p2 = await run(layerRows, (r) =>
      r.listKeysetByWebhook({ webhookId: "wh", limit: 2, cursor: p1.nextCursor }),
    );
    const p3 = await run(layerRows, (r) =>
      r.listKeysetByWebhook({ webhookId: "wh", limit: 2, cursor: p2.nextCursor }),
    );
    expect(p2.items.map((d) => d.id)).toEqual(["c", "b"]);
    expect(p3.items.map((d) => d.id)).toEqual(["a"]);
    expect(p3.nextCursor).toBe(null);
    // Full traversal hit every row exactly once, newest first.
    expect([...p1.items, ...p2.items, ...p3.items].map((d) => d.id)).toEqual([
      "e",
      "d",
      "c",
      "b",
      "a",
    ]);
  });

  it("breaks ties on equal receivedAt deterministically by id", async () => {
    const rows = [mk("a", 5), mk("b", 5), mk("c", 5)];
    const page = await run([...rows], (r) =>
      r.listKeysetByWebhook({ webhookId: "wh", limit: 2, cursor: null }),
    );
    // Same receivedAt: ordered by id DESC -> c, b, then a on next page.
    expect(page.items.map((d) => d.id)).toEqual(["c", "b"]);
    const next = await run([...rows], (r) =>
      r.listKeysetByWebhook({ webhookId: "wh", limit: 2, cursor: page.nextCursor }),
    );
    expect(next.items.map((d) => d.id)).toEqual(["a"]);
  });

  it("scopes paging to the requested webhook", async () => {
    const rows = [mk("a", 1), { ...mk("x", 9), webhookId: "other" }];
    const page = await run([...rows], (r) =>
      r.listKeysetByWebhook({ webhookId: "wh", limit: 10, cursor: null }),
    );
    expect(page.items.map((d) => d.id)).toEqual(["a"]);
  });
});

describe("WebhookDeliveryRepo.pruneOldest", () => {
  it("keeps the N newest rows and drops the rest in one statement", async () => {
    // 5 rows, retain 2 → the two newest (by receivedAt DESC) survive.
    const store = [mk("a", 1), mk("b", 2), mk("c", 3), mk("d", 4), mk("e", 5)];
    await run(store, (r) => r.pruneOldest("wh", 2));
    expect(store.map((d) => d.id).sort()).toEqual(["d", "e"]);
  });

  it("is a no-op when the log is already at or under the cap", async () => {
    const store = [mk("a", 1), mk("b", 2)];
    await run(store, (r) => r.pruneOldest("wh", 5));
    expect(store.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("breaks ties on equal receivedAt by id DESC when choosing survivors", async () => {
    const store = [mk("a", 5), mk("b", 5), mk("c", 5)];
    await run(store, (r) => r.pruneOldest("wh", 2));
    // Same receivedAt: keep the two highest ids (c, b); drop a.
    expect(store.map((d) => d.id).sort()).toEqual(["b", "c"]);
  });

  it("only prunes the requested webhook's rows", async () => {
    const store = [
      mk("a", 1),
      mk("b", 2),
      mk("c", 3),
      { ...mk("x", 9), webhookId: "other" },
    ];
    await run(store, (r) => r.pruneOldest("wh", 1));
    // wh pruned to its 1 newest (c); the other webhook's row is untouched.
    expect(store.map((d) => d.id).sort()).toEqual(["c", "x"]);
  });
});
