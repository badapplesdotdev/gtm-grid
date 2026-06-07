import { defineConfig } from "vitest/config";

// The web app's OFFLINE suites: the tRPC procedure tests (createCaller against a
// TestLayer context). They never open a live connection — the services are
// swapped for in-memory Test Layers — so the default "node" environment runs
// them directly. UI/route files are not under test here.
export default defineConfig({
  test: {
    name: "web",
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
