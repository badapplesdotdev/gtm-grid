// CSV import — "Create table" call-to-action end-to-end tests.
//
// On the "Map your columns" review step we draw the eye to the primary action
// with a pulsing glow on the button plus an arrow that nudges toward it. These
// tests drive the real renderer to that step (open import → use sample data) and
// assert the effect is (a) present and actually animating on review, (b) scoped
// to the review step only, and (c) disabled under prefers-reduced-motion.

import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// Open the CSV import flow via the command palette and land on the review step
// ("Map your columns") by ingesting the built-in sample data — no real file drop
// needed, and parsing is client-side so it works against the mock cloud.
async function gotoReviewStep(window: Page): Promise<void> {
  await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });

  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await window.keyboard.press(`${mod}+KeyK`);
  const palette = window.locator("[cmdk-input]");
  await expect(palette).toBeVisible();
  await palette.fill("Import CSV");
  await window.keyboard.press("Enter");

  // Drop step.
  await expect(window.locator(".import-title", { hasText: "Import a CSV" })).toBeVisible();
  await window.getByRole("button", { name: /use sample data/i }).click();

  // Review step.
  await expect(window.locator(".import-title", { hasText: "Map your columns" })).toBeVisible();
}

test.describe("CSV import — Create table CTA", () => {
  test("the Create table button glows and an arrow nudges toward it on review", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await gotoReviewStep(window);

    const createBtn = window.getByRole("button", { name: /create table/i });
    await expect(createBtn).toBeVisible();
    await expect(createBtn).toBeEnabled();

    // The glow class is applied while the button is actionable…
    await expect(createBtn).toHaveClass(/import-cta-glow/);
    // …and the keyframes are actually wired up (not just the class present).
    await expect
      .poll(() => createBtn.evaluate((el) => getComputedStyle(el).animationName))
      .toBe("import-cta-pulse");

    // The nudge arrow is visible and running its own animation.
    const hint = window.locator(".import-cta-hint");
    await expect(hint).toBeVisible();
    await expect
      .poll(() => hint.evaluate((el) => getComputedStyle(el).animationName))
      .toBe("import-cta-nudge");
  });

  test("the glow and arrow are scoped to the review step (absent on the drop step)", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });

    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await window.keyboard.press(`${mod}+KeyK`);
    const palette = window.locator("[cmdk-input]");
    await expect(palette).toBeVisible();
    await palette.fill("Import CSV");
    await window.keyboard.press("Enter");

    // On the drop step there is no CTA glow and no nudge arrow yet.
    await expect(window.locator(".import-title", { hasText: "Import a CSV" })).toBeVisible();
    await expect(window.locator(".import-cta-glow")).toHaveCount(0);
    await expect(window.locator(".import-cta-hint")).toHaveCount(0);
  });

  test("the glow and arrow respect prefers-reduced-motion", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await window.emulateMedia({ reducedMotion: "reduce" });
    await gotoReviewStep(window);

    const createBtn = window.getByRole("button", { name: /create table/i });
    // Class is still applied, but the animation is suppressed by the media query.
    await expect(createBtn).toHaveClass(/import-cta-glow/);
    await expect
      .poll(() => createBtn.evaluate((el) => getComputedStyle(el).animationName))
      .toBe("none");

    const hint = window.locator(".import-cta-hint");
    await expect(hint).toBeVisible();
    await expect
      .poll(() => hint.evaluate((el) => getComputedStyle(el).animationName))
      .toBe("none");
  });
});
