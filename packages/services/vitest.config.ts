import { defineConfig } from "vitest/config";

// `@gtmgrid/services` holds the Effect repositories + domain services that the
// tRPC routers build on. Every suite runs OFFLINE: services are exercised
// against their in-memory Test Layers (no live Postgres), so the default "node"
// environment runs them directly with no setup.
export default defineConfig({
  test: {
    name: "services",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
