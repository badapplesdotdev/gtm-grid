#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
const runDir = join(repoRoot, ".gtmgrid", "e2e");
const statusPath = join(runDir, "status.json");
const logPath = join(runDir, "latest.log");

const quietEnvironment = () => {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
};

const readStatus = () => {
  if (!existsSync(statusPath)) return undefined;

  try {
    return JSON.parse(readFileSync(statusPath, "utf8"));
  } catch {
    return undefined;
  }
};

const writeStatus = (status) => {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
};

const isRunning = (pid) => {
  if (!Number.isInteger(pid)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const refreshInterruptedRun = (status) => {
  if (status?.state !== "running" || isRunning(status.pid)) return status;

  const interrupted = {
    ...status,
    state: "interrupted",
    finishedAt: new Date().toISOString(),
  };
  writeStatus(interrupted);
  return interrupted;
};

const start = () => {
  const previous = refreshInterruptedRun(readStatus());
  if (previous?.state === "running") {
    console.log(`Electron E2E is already running (pid ${previous.pid}).`);
    console.log(`Status: pnpm e2e:status`);
    return;
  }

  mkdirSync(runDir, { recursive: true });
  const startedAt = new Date().toISOString();
  writeStatus({ state: "starting", startedAt, logPath });

  const log = openSync(logPath, "w");
  const worker = spawn(process.execPath, [scriptPath, "worker", startedAt], {
    cwd: repoRoot,
    detached: true,
    env: quietEnvironment(),
    stdio: ["ignore", log, log],
  });
  closeSync(log);

  writeStatus({ state: "running", pid: worker.pid, startedAt, logPath });
  worker.unref();

  console.log(`Electron E2E started in the background (pid ${worker.pid}).`);
  console.log(`Status: pnpm e2e:status`);
  console.log(`Log:    pnpm e2e:log`);
};

const worker = (startedAt) => {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const run = spawn(pnpm, ["--filter", "@gtmgrid/desktop", "e2e"], {
    cwd: repoRoot,
    env: quietEnvironment(),
    stdio: "inherit",
  });

  run.on("error", (error) => {
    console.error(error);
    writeStatus({
      state: "failed",
      pid: process.pid,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      logPath,
    });
    process.exit(1);
  });

  run.on("exit", (code, signal) => {
    const exitCode = code ?? 1;
    writeStatus({
      state: exitCode === 0 ? "passed" : "failed",
      pid: process.pid,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      signal,
      logPath,
    });
    process.exit(exitCode);
  });
};

const showStatus = () => {
  const status = refreshInterruptedRun(readStatus());
  if (!status) {
    console.log("Electron E2E has not been run in this worktree.");
    return;
  }

  const detail = status.exitCode === undefined ? "" : ` (exit ${status.exitCode})`;
  console.log(`Electron E2E: ${status.state}${detail}`);
  console.log(`Started: ${status.startedAt}`);
  if (status.finishedAt) console.log(`Finished: ${status.finishedAt}`);
  console.log(`Log: ${status.logPath}`);
};

const showLog = () => {
  if (!existsSync(logPath)) {
    console.log("Electron E2E has no log in this worktree.");
    return;
  }

  const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
  console.log(lines.slice(-60).join("\n"));
};

const command = process.argv[2] ?? "start";

if (command === "worker") {
  worker(process.argv[3] ?? new Date().toISOString());
} else if (command === "start") {
  start();
} else if (command === "status") {
  showStatus();
} else if (command === "log") {
  showLog();
} else {
  console.error("Usage: run-e2e-background.mjs <start|status|log>");
  process.exit(1);
}
