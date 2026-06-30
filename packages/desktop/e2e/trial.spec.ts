// Trial-gating end-to-end tests — the renderer's trial lifecycle driven by the
// mock cloud's `workspaces.me` plan payload (plan id + trialEndsAt + cloud
// actions). Proves the hard lock on an expired trial and the trial-status
// notifications (welcome → countdown → low credits → expired), plus the upgrade
// prompt funnel.

import { test, expect } from "./fixtures";

const DAY = 86_400_000;

/** Open the bell and return the notification popover locator. */
async function openNotifications(window: import("@playwright/test").Page) {
  await expect(window.locator(".notif-bell")).toBeVisible({ timeout: 20_000 });
  await window.locator(".notif-bell").click();
  const pop = window.locator(".notif-pop");
  await expect(pop).toBeVisible();
  return pop;
}

test.describe("Trial gating", () => {
  test("active trial (mid) → app shell + countdown notification", async ({ launchApp }) => {
    const { window } = await launchApp({
      signedIn: true,
      paid: true,
      trialEndsAt: Date.now() + 5 * DAY,
    });
    // Not locked: the live grid is shown.
    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".grid-table")).toBeVisible();
    await expect(window.getByText(/cloud is locked/i)).toHaveCount(0);

    // The bell carries the countdown notification.
    const pop = await openNotifications(window);
    await expect(
      pop.locator(".notif-item-title", { hasText: /Trial ends in \d+ days?/ }),
    ).toBeVisible();
  });

  test("fresh trial → welcome notification (countdown suppressed)", async ({ launchApp }) => {
    // A brand-new 7-day trial is inside the first-day welcome window.
    const { window } = await launchApp({
      signedIn: true,
      paid: true,
      trialEndsAt: Date.now() + 7 * DAY,
    });
    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    const pop = await openNotifications(window);
    await expect(
      pop.locator(".notif-item-title", { hasText: /your free trial is active/i }),
    ).toBeVisible();
    // The redundant countdown is suppressed while the welcome shows.
    await expect(
      pop.locator(".notif-item-title", { hasText: /Trial ends in/ }),
    ).toHaveCount(0);
  });

  test("expired by date (plan id still 'team', not yet synced) → cloud locked + upgrade prompt", async ({ launchApp }) => {
    // The CORE backstop: trialEndsAt is in the past but Autumn hasn't flipped the
    // plan id to null yet. The renderer must lock anyway (and the server blocks
    // credited actions via the same date check).
    const { window } = await launchApp({
      signedIn: true,
      paid: true,
      trialEndsAt: Date.now() - DAY,
    });
    await expect(window.getByText(/cloud is locked/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(window.getByRole("button", { name: /upgrade to unlock/i }).first()).toBeVisible();
    // The editable grid is replaced by the upgrade prompt.
    await expect(window.locator(".cell-value", { hasText: /^Acme$/ })).toHaveCount(0);

    // The bell carries the dismissible "trial expired" companion.
    const pop = await openNotifications(window);
    await expect(
      pop.locator(".notif-item-title", { hasText: /your free trial has ended/i }),
    ).toBeVisible();

    // Upgrade CTA opens the Plan & billing modal (the existing checkout funnel).
    await pop.getByRole("button", { name: /upgrade now/i }).first().click();
    await expect(window.locator(".modal-title", { hasText: /plan & billing/i })).toBeVisible();
  });

  test("expired + synced (plan id null) → cloud locked + expired notification", async ({ launchApp }) => {
    const { window } = await launchApp({
      signedIn: true,
      paid: false,
      trialEndsAt: Date.now() - DAY,
    });
    await expect(window.getByText(/cloud is locked/i).first()).toBeVisible({ timeout: 20_000 });
    const pop = await openNotifications(window);
    await expect(
      pop.locator(".notif-item-title", { hasText: /your free trial has ended/i }),
    ).toBeVisible();
  });

  test("locked panel upgrade button opens the billing modal", async ({ launchApp }) => {
    const { window } = await launchApp({
      signedIn: true,
      paid: false,
      trialEndsAt: Date.now() - DAY,
    });
    const upgrade = window.getByRole("button", { name: /upgrade to unlock/i }).first();
    await expect(upgrade).toBeVisible({ timeout: 20_000 });
    await upgrade.click();
    await expect(window.locator(".modal-title", { hasText: /plan & billing/i })).toBeVisible();
  });

  test("near the cloud-actions limit → low-credits warning", async ({ launchApp }) => {
    const { window } = await launchApp({
      signedIn: true,
      paid: true,
      trialEndsAt: Date.now() + 5 * DAY,
      cloudActionsUsed: 90,
      cloudActionsLimit: 100,
    });
    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    const pop = await openNotifications(window);
    await expect(
      pop.locator(".notif-item-title", { hasText: /cloud actions running low/i }),
    ).toBeVisible();
  });
});
