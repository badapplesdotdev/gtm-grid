/**
 * drizzle-kit config for `@gtmgrid/db`.
 *
 * `pnpm db:generate` reads `./src/schema.ts` and writes SQL migrations to
 * `./migrations` OFFLINE — it diffs the TypeScript schema against the prior
 * migration snapshot and needs NO live database. `pnpm db:migrate` applies those
 * committed migrations against `DATABASE_URL` (the pooled Supabase connection).
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    // Only consumed by `db:migrate`/`db:push`; `db:generate` is fully offline.
    url: process.env.DATABASE_URL ?? "",
  },
});
