// Boot-gate end-to-end tests — the renderer's auth/plan/loading branches, driven
// by the mock cloud's `get-session` + `workspaces.me` responses.

import { test, expect, resetMock } from "./fixtures";

test.describe("Boot gate", () => {
  test("signed out → shows the hard auth gate", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: false });
    await expect(window.locator(".gtm-onboarding, .ob-flow-shell").first()).toBeVisible();
    await expect(window.locator('input[type="email"]')).toBeVisible();
    await expect(window.locator('input[type="password"]')).toBeVisible();
    await expect(window.getByRole("button", { name: /sign in/i })).toBeVisible();
    // The app shell must NOT be present behind the gate.
    await expect(window.locator(".grid-table")).toHaveCount(0);
  });

  test("signed in on a paid plan → shows the app shell + live grid", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".sidebar-item-name", { hasText: "Leads" })).toBeVisible();
    await expect(window.locator(".grid-table")).toBeVisible();
    await expect(window.locator(".account-name", { hasText: "Acme" })).toBeVisible();
  });

  test("signed in on the free plan → shows the cloud-locked state (no grid)", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: false });
    await expect(window.getByText(/cloud is locked/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(window.getByRole("button", { name: /upgrade to unlock/i }).first()).toBeVisible();
    // The editable grid is replaced by the upgrade prompt.
    await expect(window.locator(".cell-value", { hasText: /^Acme$/ })).toHaveCount(0);
  });

  test("transition: signing in flips the gate to the app shell", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: false });
    await expect(window.locator(".gtm-onboarding, .ob-flow-shell").first()).toBeVisible();
    // Flip the mock to a signed-in session, then reload the renderer.
    await resetMock({ signedIn: true, paid: true });
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".sidebar-item-name", { hasText: "Leads" })).toBeVisible();
  });
});
