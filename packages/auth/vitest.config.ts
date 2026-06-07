import { defineConfig } from "vitest/config";

// The auth package holds the Better Auth server + pure helpers (OTP gen,
// provider gating, Supabase JWT). The unit tests cover the pure helpers only —
// no live DB, no network, no DATABASE_URL — so the default "node" environment
// runs them directly.
export default defineConfig({
  test: {
    name: "auth",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
