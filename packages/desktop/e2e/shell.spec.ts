// Electron SHELL end-to-end tests — the integration layer that unit tests can't
// reach: the real main process, the preload bridge, the IPC surface, the engine
// utilityProcess, the custom protocol, and deep-link delivery. These run against
// the REAL packaged main (build/electron/main.cjs).

import { test, expect } from "./fixtures";

test.describe("Electron shell", () => {
  test("opens exactly one window pointed at the renderer", async ({ launchApp }) => {
    const { app, window } = await launchApp();
    expect(app.windows().length).toBe(1);
    expect(window.url()).toContain("/index.html");
  });

  test("exposes the full preload bridge (contextIsolation on)", async ({ launchApp }) => {
    const { window } = await launchApp();
    const keys = await window.evaluate(() => Object.keys((window as any).electronAPI ?? {}).sort());
    expect(keys).toEqual(
      [
        "isElectron",
        "onOauthCallback",
        "onUpdateAvailable",
        "onUpdateDownloaded",
        "onUpdateError",
        "openExternal",
        "quitAndInstall",
        "sidecarDiagnostics",
        "stopSidecar",
      ].sort(),
    );
    const isElectron = await window.evaluate(() => (window as any).electronAPI.isElectron);
    expect(isElectron).toBe(true);
  });

  test("sidecarDiagnostics IPC round-trips engine facts from the main process", async ({ launchApp }) => {
    const { window } = await launchApp();
    const diag = await window.evaluate(() => (window as any).electronAPI.sidecarDiagnostics());
    expect(diag).toMatchObject({
      appVersion: expect.any(String),
      os: expect.any(String),
      arch: expect.any(String),
      spawnStatus: expect.any(String),
    });
    // The engine is spawned as an Electron utilityProcess at boot.
    expect(["spawned", "exited", "binary_missing", "pending"]).toContain(diag.spawnStatus);
    expect(typeof diag.serverPath).toBe("string");
  });

  test("stopSidecar IPC resolves (kills the engine + releases locks)", async ({ launchApp }) => {
    const { window } = await launchApp();
    const ok = await window.evaluate(async () => {
      await (window as any).electronAPI.stopSidecar();
      return true;
    });
    expect(ok).toBe(true);
  });

  test("registers the privileged app:// renderer protocol", async ({ launchApp }) => {
    const { app } = await launchApp();
    const handled = await app.evaluate(({ protocol }) => protocol.isProtocolHandled("app"));
    expect(handled).toBe(true);
  });

  test("delivers gtmgrid:// deep-link OAuth callbacks to the renderer", async ({ launchApp }) => {
    const { app, window } = await launchApp();
    // Subscribe in the renderer through the preload bridge.
    await window.evaluate(() => {
      (window as any).__oauthUrls = [];
      (window as any).electronAPI.onOauthCallback((url: string) => (window as any).__oauthUrls.push(url));
    });
    // Emit the IPC event from the MAIN process, exactly as a deep link would.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("oauth-callback", "gtmgrid://oauth?code=e2e123");
    });
    await expect
      .poll(() => window.evaluate(() => (window as any).__oauthUrls ?? []))
      .toContain("gtmgrid://oauth?code=e2e123");
  });

  test("update IPC channels deliver to the renderer", async ({ launchApp }) => {
    const { app, window } = await launchApp();
    await window.evaluate(() => {
      (window as any).__updates = [];
      (window as any).electronAPI.onUpdateAvailable((v: string) => (window as any).__updates.push(v));
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("updater:available", "9.9.9");
    });
    await expect.poll(() => window.evaluate(() => (window as any).__updates ?? [])).toContain("9.9.9");
  });
});
