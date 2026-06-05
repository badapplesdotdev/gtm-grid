import { defineConfig } from "vitest/config";

// Engine is ESM ("type":"module") and depends on native/wasm modules
// (better-sqlite3, quickjs-emscripten). The "node" environment runs tests in a
// real Node process so those modules load normally; we keep them external so
// Vite never tries to bundle the native/wasm binaries.
export default defineConfig({
  test: {
    name: "engine",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  optimizeDeps: {
    exclude: ["better-sqlite3", "quickjs-emscripten"],
  },
  ssr: {
    external: ["better-sqlite3", "quickjs-emscripten"],
  },
});
