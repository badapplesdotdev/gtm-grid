// Google Sheets import + ongoing sync end-to-end coverage. The mock models the
// Picker grant and an upstream sheet edit, while the real renderer owns every
// user interaction and React Query refresh.

import { test, expect, mockState } from "./fixtures";

async function createBlankTable(window: import("@playwright/test").Page): Promise<string> {
  await expect(window.locator('button[title="Add table or folder"]')).toBeVisible({ timeout: 20_000 });
  await window.locator('button[title="Add table or folder"]').click();
  await window.getByText("New table", { exact: true }).first().click();
  await window.getByText("Start empty").click();
  await expect(window.getByText("0 rows · 0 cols")).toBeVisible();
  return await expect.poll(async () => (await mockState()).tables.at(-1)?.id).not.toBeUndefined()
    .then(async () => (await mockState()).tables.at(-1).id);
}

async function openSheetImport(window: import("@playwright/test").Page): Promise<void> {
  await window.keyboard.press("Meta+K");
  const search = window.getByPlaceholder("Search tables and actions…");
  await expect(search).toBeVisible();
  await search.fill("Google Sheets");
  await window.getByText("Import from Google Sheets", { exact: true }).click();
  await expect(window.getByText("GTM Grid staging QA", { exact: true })).toBeVisible();
}

async function importSheet(window: import("@playwright/test").Page): Promise<void> {
  await openSheetImport(window);
  await window.getByText("GTM Grid staging QA", { exact: true }).click();
  await expect(window.getByRole("button", { name: "Import 3 columns" })).toBeVisible();
  await window.getByRole("button", { name: "Import 3 columns" }).click();
}

test.describe("Google Sheets sync", () => {
  test("the first import refreshes the open grid without a reload", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    const tableId = await createBlankTable(window);

    await importSheet(window);

    await expect.poll(async () => {
      const state = await mockState();
      return {
        columns: state.columns.filter((column: { tableId: string }) => column.tableId === tableId).length,
        rows: state.rows.filter((row: { tableId: string }) => row.tableId === tableId).length,
      };
    }).toEqual({ columns: 3, rows: 3 });

    // Regression: the backend was populated but both cached grid queries stayed
    // at the blank-table snapshot until the user reloaded the whole app.
    await expect(window.getByText("3 rows · 3 cols")).toBeVisible();
    await expect(window.locator(".cell-value", { hasText: "ada@example.com" })).toBeVisible();
  });

  test("shows the binding and pulls upstream changes with Sync now", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    const tableId = await createBlankTable(window);
    await importSheet(window);

    const strip = window.locator(".sheet-strip");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("GTM Grid staging QA · Leads");
    await expect(strip).toContainText("3 rows synced");
    await expect(strip).toContainText("Daily");

    await strip.getByRole("button", { name: "Sync now" }).click();
    await expect.poll(async () => {
      const binding = (await mockState()).sheetBindings.find(
        (candidate: { tableId: string }) => candidate.tableId === tableId,
      );
      return { syncCount: binding?.syncCount, rowsSynced: binding?.rowsSynced };
    }).toEqual({ syncCount: 2, rowsSynced: 4 });

    await expect(window.getByText("4 rows · 3 cols")).toBeVisible();
    await expect(window.locator(".cell-value", { hasText: "Analytical Engines Updated" })).toBeVisible();
    await expect(window.locator(".cell-value", { hasText: "katherine@example.com" })).toBeVisible();
    await expect(strip).toContainText("1 new · 1 updated · 2 unchanged");
  });
});
