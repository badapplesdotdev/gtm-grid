import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { NextConfig } from "next";

// The monorepo root (two levels up from apps/inngest). Pinning the tracing root
// stops Next from inferring it from a stray lockfile and keeps the engine/cloud
// workspace sources inside the traced file set.
const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Next.js config for the headless webhook/Inngest worker app.
 *
 * - `transpilePackages`: `@gtmgrid/engine` and `@gtmgrid/cloud` ship raw,
 *   uncompiled TypeScript (their `main` points at `./src/index.ts`), so Next
 *   must transpile them like first-party source rather than treat them as
 *   pre-built node_modules.
 * - `serverExternalPackages`: `better-sqlite3` (a native addon) and
 *   `quickjs-emscripten` (a WASM module) must NOT be bundled by Next's server
 *   compiler — they are `require()`d at runtime from node_modules. The engine's
 *   cloud path never loads better-sqlite3 (it is built with NO `Db`; the native
 *   addon is lazy), but keeping it external guarantees the bundler never tries
 *   to inline the `.node` binary. quickjs-emscripten runs fine on Node as WASM.
 */
const nextConfig: NextConfig = {
  outputFileTracingRoot: monorepoRoot,
  transpilePackages: ["@gtmgrid/engine", "@gtmgrid/cloud"],
  serverExternalPackages: ["better-sqlite3", "quickjs-emscripten"],
  // @gtmgrid/engine + @gtmgrid/cloud are raw NodeNext TypeScript: their internal
  // imports carry explicit `.js` extensions (e.g. `./execute.js`) that actually
  // resolve to `.ts` sources. Teach webpack to try the `.ts`/`.tsx` source when a
  // `.js` import has no real `.js` file, so the transpiled workspace packages
  // resolve during `next build`.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
