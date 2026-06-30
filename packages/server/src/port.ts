// Loopback-port lifecycle helpers for the desktop engine: a cross-platform
// process-liveness probe (used by the parent-death watchdog) and a stale-holder
// reclaim (used on EADDRINUSE). Kept in their own module — separate from the
// side-effectful index.ts entrypoint — so they can be unit-tested without booting
// the whole HTTP engine.

import { execFileSync } from "node:child_process";

export interface PortLogger {
  info: (msg: string) => void;
}

/**
 * Cross-platform process-liveness probe. `process.kill(pid, 0)` sends no signal —
 * it only checks existence, throwing `ESRCH` when the process is gone. Crucially
 * this works on WINDOWS too, unlike the Unix-only `ppid`-reparent-to-init trick the
 * orphan watchdog used to rely on (which never fired on Windows, so orphaned
 * engines there lived forever holding the port).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find and kill whatever LISTENS on `port` (loopback). On this private engine port
 * the holder is almost certainly our OWN orphaned engine from a prior session
 * (especially a Windows orphan the watchdog couldn't reach). Best-effort +
 * cross-platform (`netstat`+`taskkill` on win32, `lsof`+`SIGKILL` elsewhere);
 * `netstat`/`lsof` may be absent, and we never kill our own pid. This is what lets
 * a machine that already has a stuck orphan self-heal once the new engine starts.
 */
export function reclaimPort(port: number, log?: PortLogger): void {
  for (const pid of listenerPids(port)) {
    if (pid === process.pid) continue;
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", timeout: 5000, windowsHide: true });
      } else {
        process.kill(pid, "SIGKILL");
      }
      log?.info(`reclaimed port ${port}: killed stale pid ${pid}`);
    } catch {
      /* already gone / access denied */
    }
  }
}

/** PIDs LISTENING on `port` (loopback), resolved via the platform's port tool. */
export function listenerPids(port: number): number[] {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      const pids = new Set<number>();
      for (const line of out.split("\n")) {
        if (!/LISTENING/i.test(line) || !line.includes(`:${port} `)) continue;
        const pid = Number(line.trim().split(/\s+/).pop());
        if (pid > 0) pids.add(pid);
      }
      return [...pids];
    }
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 5000 });
    return out
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0);
  } catch {
    return []; // tool unavailable / nothing listening
  }
}
