// Bundle the engine sidecar (server + MCP) into a self-contained directory the
// packaged app can run without the dev repo. esbuild bundles all pure-JS deps;
// native (better-sqlite3) and wasm (quickjs) packages stay external and are
// installed cleanly via npm. A node binary is copied in by the shell wrapper.

import { build } from "esbuild";
import { mkdirSync, writeFileSync, cpSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", ".."); // packages/desktop/scripts -> repo root
const out = resolve(here, "..", "src-tauri", "sidecar");

// Note: we intentionally do NOT wipe `out` — it holds the installed node_modules
// (native deps) and the copied `node` binary. Re-running only refreshes the JS.

// Native/wasm packages that cannot be bundled — installed via npm instead.
const EXTERNAL = [
  "better-sqlite3",
  "bindings",
  "file-uri-to-path",
  "quickjs-emscripten",
  "quickjs-emscripten-core",
  "@jitl/*",
];

mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: EXTERNAL,
  // ESM interop for CJS deps that get bundled (anthropic/openai/mcp sdk).
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
};

await build({ ...common, entryPoints: [resolve(repo, "packages/server/src/index.ts")], outfile: resolve(out, "server.mjs") });
await build({ ...common, entryPoints: [resolve(repo, "packages/mcp/src/index.ts")], outfile: resolve(out, "mcp.mjs") });

// Declare only the external native/wasm deps; npm resolves their transitives.
writeFileSync(
  resolve(out, "package.json"),
  JSON.stringify(
    {
      name: "gtmgrid-sidecar",
      private: true,
      type: "module",
      dependencies: { "better-sqlite3": "^11.10.0", "quickjs-emscripten": "^0.31.0" },
    },
    null,
    2,
  ),
);

// Ship the connector manifests so the bundled app has built-in extensions.
const extSrc = resolve(repo, "extensions");
if (existsSync(extSrc)) cpSync(extSrc, resolve(out, "extensions"), { recursive: true });

// Bundled MCP launcher: runs the bundled node + mcp.mjs (used by the agent panel
// so Claude Code / Codex connect to gtmgrid's MCP server inside the packaged app).
const launcher = resolve(out, "gtmgrid-mcp");
writeFileSync(
  launcher,
  `#!/bin/bash\nDIR="$(cd "$(dirname "$0")" && pwd)"\nexec "$DIR/node" "$DIR/mcp.mjs" "$@"\n`,
  { mode: 0o755 },
);

// Install native/wasm deps (better-sqlite3 builds, quickjs ships wasm) — only
// the first time, so incremental builds stay fast.
if (!existsSync(resolve(out, "node_modules"))) {
  console.log("Installing sidecar native deps (one-time)…");
  execSync("npm install --omit=dev --no-audit --no-fund", { cwd: out, stdio: "inherit" });
}

// Ship the node runtime so the packaged app needs no system node.
const nodeDst = resolve(out, "node");
if (!existsSync(nodeDst)) {
  copyFileSync(process.execPath, nodeDst);
  chmodSync(nodeDst, 0o755);
  console.log("Copied node runtime:", process.execPath);
}

console.log("Sidecar ready at", out);
