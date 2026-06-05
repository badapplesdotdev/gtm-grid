import { defineConfig } from "vitest/config";

// The cloud package holds the PURE Effect domain logic for the Convex tier
// (auth identity + workspace membership authz). It has no native/wasm deps and
// no Convex `_generated` imports, so the default "node" environment runs every
// suite directly. Convex handlers in `convex/` wire this logic to `ctx`; this
// package is where the business rules are exhaustively unit-tested.
export default defineConfig({
  test: {
    name: "cloud",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
