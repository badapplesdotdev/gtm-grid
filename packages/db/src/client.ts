/**
 * Pooler-aware Postgres client for the cloud tier.
 *
 * The connection points at Supabase's Supavisor pooler in TRANSACTION mode
 * (DATABASE_URL on port 6543), which is the right mode for short-lived,
 * serverless-style connections (the cloud handlers / Inngest worker).
 *
 * `prepare: false` is REQUIRED in transaction mode: Supavisor hands each
 * transaction a (possibly different) backend connection from the pool, so a
 * server-side PREPARE issued on one connection won't exist on the next one,
 * and prepared-statement reuse breaks ("prepared statement does not exist").
 * Disabling prepared statements makes postgres-js send each query inline, which
 * is safe across pooled connections.
 *
 * See: https://orm.drizzle.team/docs/connect-supabase (Supavisor section) and
 * https://supabase.com/docs/guides/database/connecting-to-postgres#transaction-mode
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/** Resolved connection string (pooled, port 6543). See `.env.example`. */
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Point it at the Supabase pooled connection " +
      "string (Supavisor transaction mode, port 6543). See .env.example.",
  );
}

/**
 * Raw postgres-js connection. `prepare: false` is mandatory for Supavisor
 * transaction mode (see file header). Exported for the rare case a caller needs
 * a raw query or to close the pool; prefer the `db` Drizzle client below.
 *
 * The pool is deliberately TINY (`max: 2`). In transaction-mode serverless,
 * every instance keeps its own pool, so the total Supavisor client connections
 * are `instances × max`. That product must stay under the Supavisor client cap,
 * otherwise new instances get "max client connections reached" and requests
 * fail. `idle_timeout` (seconds) returns idle connections to Supavisor quickly
 * so cold instances don't hoard them, and `connect_timeout` (seconds) fails
 * fast instead of hanging when the pooler is saturated.
 */
export const sqlClient = postgres(connectionString, {
  prepare: false,
  max: 2,
  idle_timeout: 20,
  connect_timeout: 10,
});

/** Drizzle client bound to the full schema. The single DB access surface. */
export const db = drizzle(sqlClient, { schema });

export type Db = typeof db;
