// Grid toolbar responsive-overflow end-to-end tests.
//
// On a wide toolbar the action buttons (Dedupe, Webhook, Export CSV, Add row)
// render inline; when the toolbar is squeezed — e.g. the agent panel open at the
// default window size — they collapse into a single "⋯" overflow menu so they
// never crowd the primary Run button off-screen. Width is driven by a
// ResizeObserver on the toolbar, so toggling the agent panel flips the layout.

import { test, expect, mockState } from "./fixtures";

test.describe("Grid toolbar overflow", () => {
  test("wide (agent panel collapsed) → action buttons render inline", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".grid-table")).toBeVisible({ timeout: 20_000 });

    // Collapse the agent panel → the toolbar is wide → inline buttons.
    await window.locator(".agent-collapse").click();

    const toolbar = window.locator(".toolbar");
    await expect(toolbar.getByRole("button", { name: /^export csv$/i })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: /^add row$/i })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: /^webhook$/i })).toBeVisible();
    // No overflow button while everything fits.
    await expect(toolbar.locator(".toolbar-overflow-btn")).toHaveCount(0);
  });

  test("narrow (agent panel open) → actions collapse into the ⋯ menu", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".grid-table")).toBeVisible({ timeout: 20_000 });

    // Default layout has the agent panel open, squeezing the toolbar → compact.
    const toolbar = window.locator(".toolbar");
    await expect(toolbar.locator(".toolbar-overflow-btn")).toBeVisible({ timeout: 20_000 });
    // The secondary actions are NOT inline anymore…
    await expect(toolbar.getByRole("button", { name: /^export csv$/i })).toHaveCount(0);
    await expect(toolbar.getByRole("button", { name: /^webhook$/i })).toHaveCount(0);
    // …but the primary Run button stays inline.
    await expect(toolbar.getByRole("button", { name: /^run$/i })).toBeVisible();

    // Open the overflow menu — it lists every collapsed action.
    await toolbar.locator(".toolbar-overflow-btn").click();
    const menu = window.locator(".ctx-menu");
    await expect(menu).toBeVisible();
    for (const label of ["Dedupe", "Webhook", "Export CSV", "Add row"]) {
      await expect(menu.getByRole("button", { name: new RegExp(`^${label}$`, "i") })).toBeVisible();
    }
  });

  test("an overflow-menu action runs (Add row persists)", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".grid-table")).toBeVisible({ timeout: 20_000 });
    const before = (await mockState()).rows.length;

    const toolbar = window.locator(".toolbar");
    await expect(toolbar.locator(".toolbar-overflow-btn")).toBeVisible({ timeout: 20_000 });
    await toolbar.locator(".toolbar-overflow-btn").click();
    await window.locator(".ctx-menu").getByRole("button", { name: /^add row$/i }).click();

    await expect.poll(async () => (await mockState()).rows.length).toBe(before + 1);
  });
});
