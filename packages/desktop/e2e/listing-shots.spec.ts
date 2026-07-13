// One-off capture of Attio App Store listing screenshots from the REAL app UI
// over the mock cloud. Not part of the regular suite (run explicitly).

import { test, expect } from "./fixtures";

const OUT = "../../marketing/attio-app-store";
const CONNECTED = { signedIn: true, paid: true, crmConnected: true };

async function toConfigure(window: import("@playwright/test").Page) {
  await expect(window.locator('button[title="Add table or folder"]')).toBeVisible({ timeout: 20_000 });
  await window.locator('button[title="Add table or folder"]').click();
  await window.getByText("New table", { exact: true }).first().click();
  await window.getByText("From your CRM").click();
  await window.locator(".crmw-crm-card", { hasText: "Attio" }).first().click();
  await expect(window.locator(".crmw-source-grid")).toBeVisible();
}

test("capture listing screenshots", async ({ launchApp }) => {
  const { app, window } = await launchApp(CONNECTED);
  // Attio wants 2960×1848 (16:10). The harness renders at dpr 1, so instead of
  // upscaling (soft → rejected) we render a 2960×1848 window at zoomFactor 2 —
  // a true 2x rasterization of the 1480×924 layout.
  await window.setViewportSize({ width: 2960, height: 1848 });
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.setZoomFactor(2);
  });

  // 1. Wizard configure step with fields loaded.
  await toConfigure(window);
  await window.locator(".crmw-source", { hasText: "People" }).click();
  await expect(window.locator(".crmw-field", { hasText: "Email addresses" })).toBeVisible();
  await expect(window.locator(".crmw-footer")).toContainText("124"); // estimate loaded
  await window.screenshot({ path: `${OUT}/raw-1-wizard-configure.png`, scale: "device" });

  // 2. Synced grid with the status strip.
  await window.getByRole("button", { name: "Start sync" }).click();
  await expect(window.locator(".crm-strip")).toBeVisible({ timeout: 10_000 });
  await expect(window.locator(".cell-value", { hasText: "Sarah Chen" })).toBeVisible();
  await window.screenshot({ path: `${OUT}/raw-2-synced-grid.png`, scale: "device" });

  // 3. Sync log open with a completed run.
  await window.getByRole("button", { name: "Sync now" }).click();
  await window.getByRole("button", { name: "Sync log" }).click();
  await expect(window.getByText(/2 new/).first()).toBeVisible({ timeout: 10_000 });
  await window.screenshot({ path: `${OUT}/raw-3-sync-log.png`, scale: "device" });
});

test("capture demo-video extra shots", async ({ launchApp }) => {
  // Chooser + connect-step frames for the Attio submission demo video.
  const { app, window } = await launchApp({ signedIn: true, paid: true, crmConnected: false });
  await window.setViewportSize({ width: 2960, height: 1848 });
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.setZoomFactor(2);
  });

  await expect(window.locator('button[title="Add table or folder"]')).toBeVisible({ timeout: 20_000 });
  await window.locator('button[title="Add table or folder"]').click();
  await window.getByText("New table", { exact: true }).first().click();
  await expect(window.getByText("From your CRM")).toBeVisible();
  await window.screenshot({ path: `${OUT}/raw-0-chooser.png`, scale: "device" });

  await window.getByText("From your CRM").click();
  await window.locator(".crmw-crm-card", { hasText: "Attio" }).first().click();
  await expect(window.getByText("Connect your Attio account")).toBeVisible();
  await window.screenshot({ path: `${OUT}/raw-0b-connect.png`, scale: "device" });
});
