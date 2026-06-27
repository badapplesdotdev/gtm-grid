// Electron main-process domain logic as composable Effect services (repo
// convention: Effect.Service + Data.TaggedError + Layer, as in packages/services).
// The Electron lifecycle (window/tray/deep-link/ipc, in main.ts) is thin glue that
// runs these services through a ManagedRuntime. Three services, layered by
// dependency: Observability ← Engine ← Updater.

import { app, net, utilityProcess, type UtilityProcess } from "electron";
import { autoUpdater } from "electron-updater";
import { Data, Effect, Layer, ManagedRuntime } from "effect";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

declare const __POSTHOG_KEY__: string;
declare const __POSTHOG_HOST__: string;

const POSTHOG_KEY = typeof __POSTHOG_KEY__ === "string" ? __POSTHOG_KEY__ : "";
const POSTHOG_HOST = typeof __POSTHOG_HOST__ === "string" ? __POSTHOG_HOST__ : "https://us.i.posthog.com";
const ENGINE_PORT = process.env.GTMGRID_PORT ?? "8787";
const APP_ORIGIN = "app://gtmgrid";

// ── Typed errors ──────────────────────────────────────────────────────────────
export class EngineSpawnError extends Data.TaggedError("EngineSpawnError")<{
  readonly reason: string;
  readonly detail: string;
}> {}

// ── ObservabilityService — main-process PostHog (the always-deliver path) ──────
export class ObservabilityService extends Effect.Service<ObservabilityService>()("ObservabilityService", {
  sync: () => {
    const post = (event: string, properties: Record<string, unknown>): void => {
      if (!POSTHOG_KEY) return;
      const body = JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: "desktop-shell",
        properties: { source: "electron-main", platform: process.platform, arch: process.arch, version: app.getVersion(), ...properties },
      });
      net.fetch(`${POSTHOG_HOST}/i/v0/e/`, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => {});
    };
    return {
      capture: (event: string, properties: Record<string, unknown> = {}) => Effect.sync(() => post(event, properties)),
      reportException: (value: string, location = "") =>
        Effect.sync(() =>
          post("$exception", {
            $exception_list: [{ type: "ElectronMainError", value }],
            $exception_type: "ElectronMainError",
            $exception_message: value,
            location,
          }),
        ),
    } as const;
  },
}) {}

// macOS GUI apps launch with a minimal PATH; the agent CLIs live in the login PATH.
function augmentedPath(): string {
  const base = process.env.PATH ?? "";
  if (process.platform === "win32") return base;
  const home = process.env.HOME ?? "";
  let login = "";
  try {
    login = execSync(`${process.env.SHELL || "/bin/zsh"} -lic 'echo "$PATH"'`, { encoding: "utf8", timeout: 4000 }).trim();
  } catch {
    /* inherited PATH */
  }
  return [login, "/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.npm-global/bin`, base].filter(Boolean).join(":");
}
function sidecarDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "sidecar") : join(__dirname, "..", "..", "sidecar");
}
function agentCwd(): string {
  return join(app.getPath("home"), ".gtmgrid", "workspace");
}

// ── EngineService — the utilityProcess engine lifecycle + diagnostics ──────────
export class EngineService extends Effect.Service<EngineService>()("EngineService", {
  effect: Effect.gen(function* () {
    const obs = yield* ObservabilityService;
    let engine: UtilityProcess | null = null;
    let shuttingDown = false;
    const stderrTail: string[] = [];
    const facts: Record<string, unknown> = {
      appVersion: app.getVersion(),
      os: process.platform,
      arch: process.arch,
      spawnStatus: "pending",
    };

    const start = Effect.gen(function* () {
      const dir = sidecarDir();
      const server = join(dir, "server.mjs");
      facts.sidecarDir = dir;
      facts.serverPath = server;
      facts.serverExists = existsSync(server);
      if (!existsSync(server)) {
        facts.spawnStatus = "binary_missing";
        yield* obs.capture("sidecar_spawn_failed", { reason: "binary_missing", detail: server });
        return yield* Effect.fail(new EngineSpawnError({ reason: "binary_missing", detail: server }));
      }
      const startedAt = Date.now();
      const child = utilityProcess.fork(server, [], {
        cwd: dir,
        stdio: "pipe",
        env: {
          ...process.env,
          GTMGRID_PROJECT: process.env.GTMGRID_PROJECT ?? "default",
          GTMGRID_PORT: ENGINE_PORT,
          GTMGRID_MCP_NODE: process.execPath,
          GTMGRID_MCP_SCRIPT: join(dir, "mcp.mjs"),
          GTMGRID_MCP_ELECTRON_NODE: "1",
          GTMGRID_EXT_DIR: join(dir, "extensions"),
          GTMGRID_AGENT_CWD: agentCwd(),
          GTMGRID_ALLOWED_ORIGINS: app.isPackaged ? APP_ORIGIN : "",
          GTMGRID_POSTHOG_KEY: POSTHOG_KEY,
          GTMGRID_POSTHOG_HOST: POSTHOG_HOST,
          PATH: augmentedPath(),
        },
      });
      engine = child;
      facts.spawnStatus = "spawned";
      child.stdout?.on("data", (d) => process.stdout.write(`[engine] ${d}`));
      child.stderr?.on("data", (d: Buffer) => {
        process.stderr.write(`[engine] ${d}`);
        for (const line of d.toString().split("\n")) {
          if (!line.trim()) continue;
          stderrTail.push(line);
          if (stderrTail.length > 40) stderrTail.shift();
        }
      });
      child.on("exit", (code) => {
        const uptime = Date.now() - startedAt;
        facts.spawnStatus = "exited";
        facts.exitCode = code;
        facts.exitedAfterMs = uptime;
        if (!shuttingDown && uptime < 30_000) {
          void Effect.runPromise(obs.capture("sidecar_exited", { code, uptime_ms: uptime, stderr_tail: stderrTail.join("\n") }));
        }
        console.error(`[electron] engine exited (code ${code}, after ${uptime}ms)`);
      });
    });

    // Kill the engine and BLOCK until it exits (releases file locks before update).
    const stop = Effect.async<void>((resume) => {
      shuttingDown = true;
      const e = engine;
      engine = null;
      if (!e) return resume(Effect.void);
      const done = () => resume(Effect.void);
      e.once("exit", done);
      e.kill();
      setTimeout(done, 3000);
    });

    const diagnostics = Effect.sync(() => ({ ...facts, stderrTail: stderrTail.join("\n") }));

    return { start, stop, diagnostics } as const;
  }),
  dependencies: [ObservabilityService.Default],
}) {}

// ── UpdaterService — electron-updater, stops the engine before installing ──────
export class UpdaterService extends Effect.Service<UpdaterService>()("UpdaterService", {
  effect: Effect.gen(function* () {
    const engine = yield* EngineService;

    const setup = (send: (channel: string, ...args: unknown[]) => void) =>
      Effect.sync(() => {
        if (!app.isPackaged) return;
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = false;
        autoUpdater.on("update-available", (i) => send("updater:available", i.version));
        autoUpdater.on("update-downloaded", (i) => send("updater:downloaded", i.version));
        autoUpdater.on("error", (e) => send("updater:error", String(e)));
        const check = () => autoUpdater.checkForUpdates().catch(() => {});
        void check();
        setInterval(check, 2 * 60 * 60 * 1000);
      });

    // Stop the engine first (Windows file-lock ordering), then quit + install.
    const quitAndInstall = Effect.gen(function* () {
      yield* engine.stop;
      yield* Effect.sync(() => autoUpdater.quitAndInstall());
    });

    return { setup, quitAndInstall } as const;
  }),
  dependencies: [EngineService.Default],
}) {}

// ── Composed runtime ──────────────────────────────────────────────────────────
export const AppLive = Layer.mergeAll(ObservabilityService.Default, EngineService.Default, UpdaterService.Default);
export const makeRuntime = () => ManagedRuntime.make(AppLive);
export type AppRuntime = ReturnType<typeof makeRuntime>;
