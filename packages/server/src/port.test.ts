import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessAlive, listenerPids, reclaimPort } from "./port.js";

// A high, unlikely-to-collide loopback port for the reproduction.
const TEST_PORT = 18799;

/** Spawn a separate node process that LISTENS on `port` and stays alive — i.e. the
 *  exact thing that broke Windows: an orphaned engine still holding the port. */
function spawnPortHolder(port: number): Promise<ChildProcess> {
  const code = `require("http").createServer().listen(${port}, "127.0.0.1", () => process.stdout.write("ready"));`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("port holder did not become ready")), 5000);
    child.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("ready")) {
        clearTimeout(t);
        resolve(child);
      }
    });
    child.on("error", reject);
  });
}

const canBind = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });

const waitFor = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
};

let holder: ChildProcess | undefined;
afterEach(() => {
  if (holder && holder.pid && isProcessAlive(holder.pid)) holder.kill("SIGKILL");
  holder = undefined;
});

describe("isProcessAlive (cross-platform orphan watchdog liveness)", () => {
  it("reports the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("reports a process as dead once it has exited", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
    const pid = child.pid!;
    expect(isProcessAlive(pid)).toBe(true);
    child.kill("SIGKILL");
    await waitFor(() => !isProcessAlive(pid));
    expect(isProcessAlive(pid)).toBe(false);
  });
});

describe("reclaimPort (self-healing stale-orphan recovery)", () => {
  it("kills a stale process holding the port and frees it", async () => {
    // Reproduce: a separate process orphan-holds the engine port.
    holder = await spawnPortHolder(TEST_PORT);
    const holderPid = holder.pid!;

    // Precondition: the port is genuinely occupied (the bug's symptom — a new
    // engine here would hit EADDRINUSE and give up).
    expect(listenerPids(TEST_PORT)).toContain(holderPid);
    expect(await canBind(TEST_PORT)).toBe(false);

    // Apply the fix.
    reclaimPort(TEST_PORT);

    // The stale holder is killed and the port becomes bindable again.
    await waitFor(() => !isProcessAlive(holderPid));
    expect(isProcessAlive(holderPid)).toBe(false);
    let bound = false;
    for (let i = 0; i < 40 && !bound; i++) {
      bound = await canBind(TEST_PORT);
      if (!bound) await new Promise((r) => setTimeout(r, 25));
    }
    expect(bound).toBe(true);
  });

  it("never targets its own pid", () => {
    // Our own process must never appear as a reclaim target, even if (somehow) it
    // were listening — reclaimPort skips process.pid.
    expect(() => reclaimPort(TEST_PORT)).not.toThrow();
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
