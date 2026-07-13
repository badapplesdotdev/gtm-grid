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
        "downloadUpdate",
        "isElectron",
        "onOauthCallback",
        "onUpdateAvailable",
        "onUpdateDownloaded",
        "onUpdateError",
        "onUpdateProgress",
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
      (window as any).electronAPI.onUpdateAvailable((i: { version: string }) => (window as any).__updates.push(i.version));
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("updater:available", { version: "9.9.9", notes: null });
    });
    await expect.poll(() => window.evaluate(() => (window as any).__updates ?? [])).toContain("9.9.9");
  });

  test("the redesigned update dialog walks available → downloading → ready via IPC", async ({ launchApp }) => {
    const { app, window } = await launchApp();
    const send = (channel: string, payload: unknown) =>
      app.evaluate(({ BrowserWindow }, [ch, p]) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send(ch as string, p);
      }, [channel, payload] as const);

    // Offer an update with changesets-style notes → dialog with version chips
    // and categorized sections.
    await send("updater:available", {
      version: "9.9.9",
      notes: "### Minor Changes\n\n- abc1234: A shiny new capability.\n\n### Patch Changes\n\n- def5678: A squashed bug.",
    });
    await expect(window.locator(".upd-head-title")).toHaveText("Update available");
    await expect(window.locator(".upd-chip-accent", { hasText: "v9.9.9" })).toBeVisible();
    await expect(window.getByText("A shiny new capability.")).toBeVisible();
    await expect(window.getByText("A squashed bug.")).toBeVisible();

    // Start the download → live progress.
    await window.getByRole("button", { name: /Download & restart/ }).click();
    await send("updater:progress", 42);
    await expect(window.locator(".upd-progress-pct")).toHaveText("42%");

    // Downloaded → ready state with Restart now.
    await send("updater:downloaded", "9.9.9");
    await expect(window.getByText("Update ready — restart to install")).toBeVisible();
    await expect(window.getByRole("button", { name: "Restart now" })).toBeVisible();
  });
});
