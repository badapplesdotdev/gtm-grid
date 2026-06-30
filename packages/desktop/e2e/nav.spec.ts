// Navigation / menus / modals end-to-end tests — the chrome around the grid:
// the account menu, notification center, project switcher, and the new-table
// creation flow (asserted through to persisted mock state).

import { test, expect, mockState } from "./fixtures";

test.describe("Navigation & menus", () => {
  test("account menu opens with workspace, plan and billing entries", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".account-btn")).toBeVisible({ timeout: 20_000 });
    await window.locator(".account-btn").click();
    await expect(window.locator(".account-menu")).toBeVisible();
    await expect(window.getByText(/create workspace/i)).toBeVisible();
    await expect(window.getByText(/plan & billing/i)).toBeVisible();
  });

  test("notification center opens from the bell", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".notif-bell")).toBeVisible({ timeout: 20_000 });
    await window.locator(".notif-bell").click();
    await expect(window.locator(".notif-pop")).toBeVisible();
  });

  test("project switcher opens with the project search", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".sidebar-proj")).toBeVisible({ timeout: 20_000 });
    await window.locator(".sidebar-proj").click();
    await expect(window.locator('input[placeholder="Search projects…"]')).toBeVisible();
  });

  test("new-table chooser opens from the add menu and offers every source", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator('button[title="Add table or folder"]')).toBeVisible({ timeout: 20_000 });
    await window.locator('button[title="Add table or folder"]').click();
    await window.getByText("New table", { exact: true }).first().click();
    await expect(window.getByText("Start empty")).toBeVisible();
    await expect(window.getByText("Import a CSV")).toBeVisible();
    await expect(window.getByText("From Social Signals")).toBeVisible();
    await expect(window.getByText("Driven by a webhook")).toBeVisible();
  });

  test('creates a blank table end-to-end ("Start empty")', async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator('button[title="Add table or folder"]')).toBeVisible({ timeout: 20_000 });
    const before = (await mockState()).tables.length;

    await window.locator('button[title="Add table or folder"]').click();
    await window.getByText("New table", { exact: true }).first().click();
    await window.getByText("Start empty").click();

    // The new cloud table is persisted server-side…
    await expect.poll(async () => (await mockState()).tables.length).toBe(before + 1);
    // …and shows up in the sidebar (>1 table row now).
    await expect.poll(() => window.locator(".sidebar-item-name").count()).toBeGreaterThan(1);
  });

  test("workspace settings (members & seats) opens with the invite field", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    const membersBtn = window.locator('button[title="Workspace members & seats"]');
    await expect(membersBtn).toBeVisible({ timeout: 20_000 });
    await membersBtn.click();
    await expect(window.getByText("Members", { exact: true })).toBeVisible();
    await expect(window.locator('input[placeholder="teammate@company.com"]')).toBeVisible();
  });
});
