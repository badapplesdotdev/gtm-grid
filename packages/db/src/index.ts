/**
 * `@gtmgrid/db` — the cloud tier's Postgres schema + connection layer.
 *
 * `./schema` is import-safe with no side effects (pure Drizzle table defs);
 * `./client` reads `DATABASE_URL` at import time, so import it only where a live
 * connection is wanted. This barrel re-exports the schema; consumers that need
 * the client import `@gtmgrid/db/client` directly.
 */

export * as schema from "./schema.js";
