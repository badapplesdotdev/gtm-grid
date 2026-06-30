// Self-host end-to-end tests — a self-hosted backend (`GTMGRID_SELF_HOST=1`,
// surfaced on the `workspaces.me` payload as `workspace.selfHost`) has no billing,
// so the server bypasses its entitlement gate and the renderer must NEVER lock the
// cloud UI — regardless of plan id or a lapsed trial. These mirror the LOCKED
// cases in trial.spec.ts / boot.spec.ts and assert the opposite (unlocked) outcome
// once `selfHost` is set.

import { test, expect } from "./fixtures";

const DAY = 86_400_000;

/** Assert the cloud UI is fully unlocked (the live grid, no upgrade prompts). */
async function expectUnlocked(window: import("@playwright/test").Page) {
  await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
  await expect(window.locator(".grid-table")).toBeVisible();
  await expect(window.getByText(/cloud is locked/i)).toHaveCount(0);
  await expect(
    window.getByRole("button", { name: /upgrade to unlock/i }),
  ).toHaveCount(0);
}

test.describe("Self-host (GTMGRID_SELF_HOST)", () => {
  test("Free workspace (no plan) is NOT locked under self-host", async ({
    launchApp,
  }) => {
    // On the hosted product `paid:false` (plan id null) hard-locks the cloud UI
    // (see boot.spec "free-plan cloud-locked"). Self-host must keep it open.
    const { window } = await launchApp({
      signedIn: true,
      paid: false,
      selfHost: true,
    });
    await expectUnlocked(window);
  });

  test("expired-by-date trial is NOT locked under self-host", async ({
    launchApp,
  }) => {
    // The exact case trial.spec.ts locks on (trialEndsAt in the past). Under
    // self-host the date backstop must not apply — no lock, no upgrade prompt.
    const { window } = await launchApp({
      signedIn: true,
      paid: true,
      trialEndsAt: Date.now() - DAY,
      selfHost: true,
    });
    await expectUnlocked(window);
  });

  test("fully-lapsed (Free + past trial) is NOT locked under self-host", async ({
    launchApp,
  }) => {
    // Plan synced to null AND trial expired — the most-locked hosted state. Still
    // open under self-host.
    const { window } = await launchApp({
      signedIn: true,
      paid: false,
      trialEndsAt: Date.now() - DAY,
      selfHost: true,
    });
    await expectUnlocked(window);
  });
});
