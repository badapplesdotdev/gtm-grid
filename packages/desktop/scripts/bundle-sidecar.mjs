// Bundle the engine sidecar (server + MCP) into a self-contained directory the
// packaged app can run without the dev repo. esbuild bundles all pure-JS deps;
// native (better-sqlite3) and wasm (quickjs) packages stay external and are
// installed cleanly via npm. A node runtime is shipped alongside.
//
// Cross-arch: set GTMGRID_SIDECAR_ARCH (e.g. "x64") to bundle a sidecar for a
// DIFFERENT cpu than the host — used by CI to build a macOS Intel app on an Apple
// silicon runner. When the target arch differs from the host we download the
// matching node binary from nodejs.org and tell npm to fetch the matching
// better-sqlite3 prebuilt; otherwise we copy the running node (fast path).

import { build } from "esbuild";
import {
  mkdirSync,
  writeFileSync,
  cpSync,
  existsSync,
  copyFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", ".."); // packages/desktop/scripts -> repo root
const out = resolve(here, "..", "sidecar");

const isWin = process.platform === "win32";
const targetArch = process.env.GTMGRID_SIDECAR_ARCH || process.arch; // "arm64" | "x64"
const crossArch = targetArch !== process.arch;
const nodeName = isWin ? "node.exe" : "node";

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
// Wipe the destination first so a tool removed from source (its manifest +
// <tool>.skill.md) is actually dropped from the bundle — cpSync only adds/over-
// writes, it never prunes, which would otherwise resurrect deleted tools.
const extSrc = resolve(repo, "extensions");
const extDst = resolve(out, "extensions");
rmSync(extDst, { recursive: true, force: true });
if (existsSync(extSrc)) cpSync(extSrc, extDst, { recursive: true });

// No MCP launcher script is written: the agent panel mounts gtmgrid's MCP server
// by spawning the bundled `node` directly with `mcp.mjs` (above) as a script arg
// — see `mcpLaunch` in agent.ts and GTMGRID_MCP_NODE/GTMGRID_MCP_SCRIPT in the
// Rust shell. A `#!/bin/bash` launcher couldn't run on Windows, so the grid tools
// never loaded there; spawning node directly works on every platform.

// Install native/wasm deps (better-sqlite3 builds/fetches prebuilt, quickjs ships
// wasm) — only the first time, so incremental builds stay fast. When cross-
// building, force npm to fetch the TARGET arch's prebuilt (not the host's).
if (!existsSync(resolve(out, "node_modules"))) {
  console.log(`Installing sidecar native deps (arch=${targetArch})…`);
  const archFlags = crossArch ? ` --arch=${targetArch} --target_arch=${targetArch}` : "";
  execSync(`npm install --omit=dev --no-audit --no-fund${archFlags}`, {
    cwd: out,
    stdio: "inherit",
    env: crossArch ? { ...process.env, npm_config_arch: targetArch } : process.env,
  });
}

// Ship the node runtime so the packaged app needs no system node.
const nodeDst = resolve(out, nodeName);
if (!existsSync(nodeDst)) {
  if (crossArch) {
    downloadNode(process.platform, targetArch, process.versions.node, nodeDst);
  } else {
    copyFileSync(process.execPath, nodeDst);
    console.log("Copied node runtime:", process.execPath);
  }
  if (!isWin) chmodSync(nodeDst, 0o755);
}

console.log(`Sidecar ready at ${out} (target arch: ${targetArch})`);

signMacSidecar();

/**
 * Codesign every Mach-O binary inside the sidecar (the bundled `node` runtime +
 * native `.node`/`.dylib` addons) BEFORE Tauri bundles the .app. macOS
 * notarization rejects any unsigned nested executable, so each must carry our
 * Developer ID signature + the Hardened Runtime + a secure timestamp, with the
 * JIT/library-validation entitlements Node needs to run (see sidecar.entitlements).
 * No-op unless we're on macOS with APPLE_SIGNING_IDENTITY set (i.e. signed CI
 * release builds) — local/dev and non-mac builds are untouched.
 */
function signMacSidecar() {
  if (process.platform !== "darwin") return;
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  if (!identity) {
    console.log("Sidecar codesigning skipped (no APPLE_SIGNING_IDENTITY).");
    return;
  }
  const entitlements = resolve(here, "..", "src-tauri", "sidecar.entitlements");
  const found = execSync(
    `find "${out}" -type f \\( -name node -o -name '*.node' -o -name '*.dylib' \\)`,
    { encoding: "utf8" },
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const f of found) {
    execSync(
      `codesign --force --timestamp --options runtime --entitlements "${entitlements}" --sign "${identity}" "${f}"`,
      { stdio: "inherit" },
    );
  }
  console.log(`Codesigned ${found.length} sidecar binaries as "${identity}".`);
}

/** Download the official node binary for a platform+arch and place it at dest. */
function downloadNode(platform, arch, version, dest) {
  const plat = platform === "win32" ? "win" : platform; // darwin | linux | win
  const ext = platform === "win32" ? "zip" : "tar.gz";
  const base = `node-v${version}-${plat}-${arch}`;
  const url = `https://nodejs.org/dist/v${version}/${base}.${ext}`;
  console.log("Downloading node runtime:", url);
  const archive = resolve(out, `.node-dl.${ext}`);
  execSync(`curl -fsSL "${url}" -o "${archive}"`, { stdio: "inherit" });
  if (ext === "zip") {
    execSync(`unzip -q -o "${archive}" "${base}/node.exe" -d "${out}"`, { stdio: "inherit" });
    copyFileSync(resolve(out, base, "node.exe"), dest);
  } else {
    execSync(`tar -xzf "${archive}" -C "${out}" "${base}/bin/node"`, { stdio: "inherit" });
    copyFileSync(resolve(out, base, "bin", "node"), dest);
  }
  rmSync(archive, { force: true });
  rmSync(resolve(out, base), { recursive: true, force: true });
}
