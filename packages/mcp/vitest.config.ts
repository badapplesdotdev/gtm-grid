import { defineConfig } from "vitest/config";

// The MCP server's cloud data source constructs an @gtmgrid/engine Engine, which
// pulls in native/wasm deps (better-sqlite3, quickjs-emscripten). Run in the
// "node" environment and keep those external so Vite never bundles the binaries
// — mirrors packages/engine and packages/server.
export default defineConfig({
  test: {
    name: "mcp",
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
