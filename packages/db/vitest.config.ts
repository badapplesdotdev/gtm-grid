import { defineConfig } from "vitest/config";

// The db package holds the pure Drizzle schema (table defs) for the Postgres
// cloud tier. Schema tests assert table/column/index shape statically — they
// import `./src/schema.ts` only (no live DB, no DATABASE_URL), so the default
// "node" environment runs them directly.
export default defineConfig({
  test: {
    name: "db",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
