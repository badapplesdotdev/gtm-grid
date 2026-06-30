// Build the Electron main + preload with esbuild.
//
// Crucially, the PostHog key is injected here as a PLAIN JS string `define` from
// the build env (VITE_POSTHOG_KEY) — the same value the Vite renderer build bakes.
// This is the permanent fix for the Tauri key-baking bug: there is no Rust
// `option_env!` + cargo cache to defeat it, so packaged builds reliably report.

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const POSTHOG_KEY = process.env.VITE_POSTHOG_KEY ?? "";
const POSTHOG_HOST = process.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com";

await build({
  entryPoints: [resolve(root, "electron/main.ts"), resolve(root, "electron/preload.ts")],
  outdir: resolve(root, "build/electron"),
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // Electron + electron-updater are resolved from node_modules at runtime.
  external: ["electron", "electron-updater"],
  define: {
    __POSTHOG_KEY__: JSON.stringify(POSTHOG_KEY),
    __POSTHOG_HOST__: JSON.stringify(POSTHOG_HOST),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: "info",
});

console.log(
  `electron main/preload built (posthog key: ${POSTHOG_KEY ? "set" : "EMPTY — analytics off"})`,
);
