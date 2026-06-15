import { defineConfig } from "vitest/config";

// The web app's OFFLINE suites: tRPC procedure tests (createCaller against a
// TestLayer context) plus the API-route boundary tests (the worker secret/zod
// gate, the worker body schemas). They never open a live connection — services
// are swapped for in-memory Test Layers and the validation/gate paths return
// before any DB import — so the default "node" environment runs them directly.
export default defineConfig({
  test: {
    name: "web",
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
  },
});
