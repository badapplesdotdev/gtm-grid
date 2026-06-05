import { defineConfig } from "vitest/config";

// Root Vitest config using the "projects" feature so each workspace package
// can own its own test setup. `pnpm test` (vitest run) discovers every
// package config matched below and runs all suites in one pass.
//
// Native/wasm engine deps (better-sqlite3, quickjs-emscripten) must NOT be
// pre-bundled by Vite — they run fine under the default "node" environment as
// long as they stay external. See packages/engine/vitest.config.ts.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts"],
  },
});
