/**
 * `DbClient` — the per-request Drizzle handle as an Effect service.
 *
 * This is the seam between the pooled Postgres connection (`@gtmgrid/db`) and the
 * Effect world. Repositories depend on `DbClient` (not on the raw `db` import),
 * so:
 *
 *   - PRODUCTION provides {@link DbClientLive}, which yields the pooled,
 *     `prepare:false` Supavisor-transaction-mode client. The tRPC context builds
 *     it once per request from `@gtmgrid/db/client` (the pool itself is shared).
 *   - TESTS never provide `DbClient` at all — the Test Layers replace the
 *     repositories wholesale with in-memory implementations, so no live
 *     connection is ever opened.
 *
 * Keeping the handle behind a `Context.Tag` is what makes the Live/Test swap
 * total: a repository written against `DbClient` can be backed by Drizzle or by
 * an in-memory array with no change to the calling Effect program.
 */

import type { Db } from "@gtmgrid/db/client";
import { Context, Effect, Layer } from "effect";

/**
 * The Drizzle client for THIS request. A plain `Context.Tag` (not
 * `Effect.Service`) because the value is supplied externally — either the live
 * pooled handle or, in tests, never (the repos are swapped instead).
 */
export class DbClient extends Context.Tag("DbClient")<DbClient, Db>() {}

/**
 * A `DbClient` Layer wrapping an already-resolved Drizzle handle. The tRPC
 * context resolves the pooled client once (via `@gtmgrid/db/client`) and passes
 * it here, so the live connection is opened by the caller, not at import.
 */
export const dbClientLayer = (db: Db): Layer.Layer<DbClient> =>
  Layer.succeed(DbClient, db);

/**
 * The live `DbClient` Layer that resolves the pooled handle lazily from
 * `@gtmgrid/db/client`. Importing this module never opens a connection; the
 * dynamic import happens only when the Layer is built (i.e. on a real request).
 */
export const DbClientLive: Layer.Layer<DbClient> = Layer.effect(
  DbClient,
  Effect.promise(async () => {
    const { db } = await import("@gtmgrid/db/client");
    return db;
  }),
);
