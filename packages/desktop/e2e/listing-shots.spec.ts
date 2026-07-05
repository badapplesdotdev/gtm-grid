// One-off capture of Attio App Store listing screenshots from the REAL app UI
// over the mock cloud. Not part of the regular suite (run explicitly).

import { test, expect } from "./fixtures";

const OUT = "e2e/.listing-shots";
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
  const { window } = await launchApp(CONNECTED);
  await window.setViewportSize({ width: 1600, height: 1000 });

  // 1. Wizard configure step with fields loaded.
  await toConfigure(window);
  await window.locator(".crmw-source", { hasText: "People" }).click();
  await expect(window.locator(".crmw-field", { hasText: "Email addresses" })).toBeVisible();
  await window.screenshot({ path: `${OUT}/1-wizard-configure.png` });

  // 2. Synced grid with the status strip.
  await window.getByRole("button", { name: "Start sync" }).click();
  await expect(window.locator(".crm-strip")).toBeVisible({ timeout: 10_000 });
  await expect(window.locator(".cell-value", { hasText: "Sarah Chen" })).toBeVisible();
  await window.screenshot({ path: `${OUT}/2-synced-grid.png` });

  // 3. Sync log open with a completed run.
  await window.getByRole("button", { name: "Sync now" }).click();
  await window.getByRole("button", { name: "Sync log" }).click();
  await expect(window.getByText(/2 new/).first()).toBeVisible({ timeout: 10_000 });
  await window.screenshot({ path: `${OUT}/3-sync-log.png` });
});
