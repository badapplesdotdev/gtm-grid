#!/usr/bin/env node
/**
 * Boot the freshly-bundled sidecar EXACTLY as the packaged desktop shell does —
 * its own copied `node` binary running the bundled `server.mjs` — and assert that
 * `/api/health` answers. This is the CI guard for the failure that hit a Windows
 * user: the bundled engine (the `better-sqlite3` native binding, the copied node
 * runtime) failing to load on a given OS/arch, which leaves the app stuck forever
 * on the "Server not reachable" banner. Booting the real bundle exercises the
 * exact native-module load + DB init + port bind the shipped app depends on.
 *
 * Run on each NATIVE build runner right after the Tauri bundle step, before the
 * release is published. Exits non-zero (and prints the sidecar's captured output,
 * which carries the real load error) when the engine never becomes healthy.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sidecarDir = join(here, "..", "src-tauri", "sidecar");
const nodeBin = join(sidecarDir, process.platform === "win32" ? "node.exe" : "node");
const server = join(sidecarDir, "server.mjs");

// Use a non-default port so a stray dev/CI server on 8787 can never mask a real
// failure with a false "healthy".
const PORT = 8799;
const HEALTH = `http://127.0.0.1:${PORT}/api/health`;
const TIMEOUT_MS = 30_000;
const POLL_MS = 500;

for (const [label, p] of [
  ["node runtime", nodeBin],
  ["server.mjs", server],
]) {
  if (!existsSync(p)) {
    console.error(`smoke: bundled ${label} missing at ${p} — did the sidecar bundle step run?`);
    process.exit(1);
  }
}

let output = "";
const child = spawn(nodeBin, [server], {
  cwd: sidecarDir,
  env: {
    ...process.env,
    GTMGRID_PROJECT: "smoke",
    GTMGRID_PORT: String(PORT),
    GTMGRID_EXT_DIR: join(sidecarDir, "extensions"),
    GTMGRID_MCP_NODE: nodeBin,
    GTMGRID_MCP_SCRIPT: join(sidecarDir, "mcp.mjs"),
    // Never phone PostHog home from a CI smoke run.
    GTMGRID_POSTHOG_KEY: "",
  },
});
child.stdout.on("data", (d) => {
  output += d;
  process.stdout.write(d);
});
child.stderr.on("data", (d) => {
  output += d;
  process.stderr.write(d);
});

let exited = null;
child.on("exit", (code, signal) => {
  exited = { code, signal };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stop = () => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
};

const fail = (msg) => {
  console.error(`\nsmoke: FAIL — ${msg}`);
  if (output.trim()) {
    console.error(`\n--- bundled sidecar output ---\n${output.trim()}\n------------------------------`);
  }
  stop();
  process.exit(1);
};

const start = Date.now();
while (Date.now() - start < TIMEOUT_MS) {
  // An early exit means the engine couldn't even stay up — almost always a
  // native module that won't load on this OS/arch, the exact Windows failure.
  if (exited) {
    fail(
      `sidecar exited early (code=${exited.code} signal=${exited.signal}) before becoming healthy — ` +
        `likely a native module (better-sqlite3) or node runtime that won't load on ${process.platform}/${process.arch}`,
    );
  }
  try {
    const res = await fetch(HEALTH);
    if (res.ok) {
      const body = await res.json();
      if (body && body.ok) {
        console.log(`\nsmoke: OK — bundled sidecar healthy on ${process.platform}/${process.arch} (project=${body.project})`);
        stop();
        process.exit(0);
      }
    }
  } catch {
    // Not listening yet — keep polling until the timeout.
  }
  await sleep(POLL_MS);
}

fail(`sidecar did not answer ${HEALTH} within ${TIMEOUT_MS / 1000}s`);
