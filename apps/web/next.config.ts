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
  // Required to support PostHog trailing slash API requests.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://eu-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://eu-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://eu.i.posthog.com/:path*",
      },
    ];
  },
  // Baseline security headers on every response.
  async headers() {
    // Content-Security-Policy. Pragmatic but real: it blocks injected object/base
    // tags and cross-origin framing/exfiltration while allowing what the app
    // actually uses. `'unsafe-inline'`/`'unsafe-eval'` on script-src are kept
    // because Next's inline bootstrap isn't nonce-based here — tightening to a
    // nonce CSP is a follow-up. PostHog ingestion is same-origin via the `/ingest`
    // proxy; the absolute hosts are allowlisted in connect-src as a belt-and-braces
    // for direct calls. `data:`/`blob:` images cover avatars + canvas exports.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://eu.i.posthog.com https://eu-assets.i.posthog.com https://*.posthog.com https://*.ingest.vercel.com https://vitals.vercel-insights.com",
      "worker-src 'self' blob:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
    ];
  },
  // The QuickJS WASM variant is loaded by quickjs-emscripten-core via a DYNAMIC
  // import, so Next's static file tracer never sees it and it (plus its .wasm) is
  // missing from the deployed function. Force-include the variant + ffi-types for
  // the API routes that run the engine. Paths are relative to this app dir; the
  // pnpm store lives at the monorepo root.
  outputFileTracingIncludes: {
    "/api/**": [
      "../../node_modules/.pnpm/@jitl+quickjs-wasmfile-release-asyncify@*/node_modules/@jitl/quickjs-wasmfile-release-asyncify/**",
      "../../node_modules/.pnpm/@jitl+quickjs-ffi-types@*/node_modules/@jitl/quickjs-ffi-types/**",
      "../../node_modules/.pnpm/quickjs-emscripten-core@*/node_modules/quickjs-emscripten-core/**",
      "../../node_modules/.pnpm/quickjs-emscripten@*/node_modules/quickjs-emscripten/**",
    ],
  },
  transpilePackages: ["@gtmgrid/engine", "@gtmgrid/cloud", "@gtmgrid/analytics"],
  // quickjs-emscripten loads a WASM *variant* at runtime (quickjs-emscripten-core
  // + @jitl/quickjs-wasmfile-release-asyncify) whose Emscripten-generated glue
  // breaks when webpack bundles it ("a is not a function"). Every quickjs package
  // (and the variant) must stay external and be require()d from node_modules.
  serverExternalPackages: [
    "better-sqlite3",
    "quickjs-emscripten",
    "quickjs-emscripten-core",
    "@jitl/quickjs-wasmfile-release-asyncify",
    // better-auth (and its @better-auth/* internals, which each bundle kysely)
    // must not be bundled by Next's server compiler: webpack's ESM analysis trips
    // on kysely's DEFAULT_MIGRATION_TABLE root re-export and fails the build, even
    // though it resolves fine when require()d at runtime. Externalize the whole
    // @better-auth scope (the route pulls @better-auth/core + kysely-adapter, not
    // just the `better-auth` umbrella) plus kysely + the pg driver.
    "better-auth",
    "@better-auth/core",
    "@better-auth/drizzle-adapter",
    "@better-auth/kysely-adapter",
    "@better-auth/utils",
    "@better-auth/telemetry",
    "kysely",
    "postgres",
  ],
  // @gtmgrid/engine + @gtmgrid/cloud are raw NodeNext TypeScript: their internal
  // imports carry explicit `.js` extensions (e.g. `./execute.js`) that actually
  // resolve to `.ts` sources. Teach webpack to try the `.ts`/`.tsx` source when a
  // `.js` import has no real `.js` file, so the transpiled workspace packages
  // resolve during `next build`.
  webpack: (config, { isServer }) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    // serverExternalPackages alone does not externalize the quickjs WASM variant
    // under the RSC server layer, so webpack bundles its Emscripten glue and
    // breaks it ("a is not a function"). Force every quickjs / @jitl / native
    // package to be require()d at runtime instead of bundled, on the server build.
    if (isServer) {
      const existing = config.externals || [];
      const list = Array.isArray(existing) ? existing : [existing];
      list.push(({ request }: { request?: string }, cb: (err?: unknown, result?: string) => void) => {
        if (
          request &&
          (request.startsWith("quickjs-emscripten") ||
            request.startsWith("@jitl/quickjs") ||
            request === "better-sqlite3")
        ) {
          return cb(undefined, "commonjs " + request);
        }
        return cb();
      });
      config.externals = list;
    }
    return config;
  },
};

export default nextConfig;
