import { defineConfig } from "vitest/config";

// The server's cloud-run path constructs an @gtmgrid/engine Engine, which pulls
// in native/wasm deps (better-sqlite3, quickjs-emscripten). Run in the "node"
// environment and keep those external so Vite never bundles the binaries.
export default defineConfig({
  test: {
    name: "server",
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
