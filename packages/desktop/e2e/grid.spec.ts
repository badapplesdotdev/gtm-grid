// Grid + shell functionality end-to-end tests — driving the real renderer
// (signed-in, paid) against the stateful mock cloud. Writes are asserted both in
// the UI and in the persisted mock state (`mockState()`).

import { test, expect, mockState } from "./fixtures";

test.describe("Grid functionality", () => {
  test("renders the seeded table data", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".grid-table")).toBeVisible({ timeout: 20_000 });
    // Column headers.
    await expect(window.locator(".grid-th", { hasText: "Company" })).toBeVisible();
    await expect(window.locator(".grid-th", { hasText: "Domain" })).toBeVisible();
    // Seeded cell values.
    for (const v of ["Acme", "acme.com", "Globex", "globex.com"]) {
      await expect(window.locator(".cell-value", { hasText: new RegExp(`^${v}$`) })).toBeVisible();
    }
  });

  test("shows the workspace, plan and table list in the sidebar", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".account-name", { hasText: "Acme" })).toBeVisible({ timeout: 20_000 });
    await expect(window.getByText(/TEAM/).first()).toBeVisible();
    await expect(window.locator(".sidebar-item-name", { hasText: "Leads" })).toBeVisible();
  });

  test("edits a manual cell and persists the write", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".grid-table")).toBeVisible({ timeout: 20_000 });

    // Click the "Acme" cell to enter edit mode, replace its value, commit.
    await window.locator(".cell-value", { hasText: /^Acme$/ }).first().click();
    const input = window.locator(".cell-input");
    await expect(input).toBeVisible();
    await input.fill("Acme Corp");
    await input.press("Enter");

    // Reflected in the UI…
    await expect(window.locator(".cell-value", { hasText: /^Acme Corp$/ })).toBeVisible();
    // …and persisted in the mock (proves the setCell mutation reached the server).
    await expect
      .poll(async () => (await mockState()).cells?.row_1?.col_1?.value)
      .toBe("Acme Corp");
  });

  test("adds a row via the toolbar", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".grid-table")).toBeVisible({ timeout: 20_000 });
    const before = (await mockState()).rows.length;

    await window.getByRole("button", { name: /^add row$/i }).click();

    await expect.poll(async () => (await mockState()).rows.length).toBe(before + 1);
  });

  test("opens the add-column UI from the grid header", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".grid-table")).toBeVisible({ timeout: 20_000 });
    await window.locator(".add-col-btn").first().click();
    // The add-column popover/menu surfaces a name field or function options.
    await expect(
      window.locator('input[placeholder*="name" i], .acx-group, [role="dialog"]').first(),
    ).toBeVisible();
  });

  test("opens the command palette with the keyboard shortcut", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await window.keyboard.press(`${mod}+KeyK`);
    await expect(window.locator('[cmdk-root], [cmdk-input], .command-palette').first()).toBeVisible();
  });

  test("renders the agent panel with provider tabs", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".agent-panel")).toBeVisible({ timeout: 20_000 });
    await expect(window.getByRole("button", { name: /^claude$/i })).toBeVisible();
    await expect(window.getByRole("button", { name: /^codex$/i })).toBeVisible();
  });
});
