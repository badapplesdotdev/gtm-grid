import { expect, test } from "./fixtures";

test.describe("Grid view controls", () => {
  test("hides, pins, filters, and persists the table view", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".grid-table")).toBeVisible({ timeout: 20_000 });

    // Pin from the column manager. Pinned columns move to the leading edge and
    // remain sticky after the row-number gutter.
    await window.getByRole("button", { name: /2\/2 columns/i }).click();
    const domainRow = window.locator(".column-view-row", { hasText: "Domain" });
    await domainRow.locator(".column-pin-btn").click();
    await window.locator(".grid-view-backdrop").click({ position: { x: 2, y: 2 } });
    const pinnedDomain = window.locator(".grid-th.pinned-column", { hasText: "Domain" });
    await expect(pinnedDomain).toBeVisible();
    await expect(pinnedDomain).toHaveCSS("position", "sticky");

    // Hide Company; the toolbar count and actual header both update.
    await window.getByRole("button", { name: /2\/2 columns/i }).click();
    const companyRow = window.locator(".column-view-row", { hasText: "Company" });
    await companyRow.locator(".column-visibility-btn").click();
    // Hiding removes the grid column, not its manager entry. The muted entry
    // remains actionable so the same eye control can restore it.
    await expect(companyRow).toBeVisible();
    await expect(companyRow).toHaveAttribute("data-column-visibility", "hidden");
    await expect(companyRow.getByText("Hidden", { exact: true })).toBeVisible();
    await expect(companyRow.getByRole("button", { name: "Show Company" })).toBeVisible();
    await expect(window.getByRole("button", { name: /1\/2 columns/i })).toBeVisible();
    await window.locator(".grid-view-backdrop").click({ position: { x: 2, y: 2 } });
    await expect(window.locator(".grid-th", { hasText: "Company" })).toHaveCount(0);

    // Restore it, then filter to just Acme.
    await window.getByRole("button", { name: /1\/2 columns/i }).click();
    const hiddenCompanyRow = window.locator('.column-view-row[data-column-visibility="hidden"]', { hasText: "Company" });
    await hiddenCompanyRow.getByRole("button", { name: "Show Company" }).click();
    await window.locator(".grid-view-backdrop").click({ position: { x: 2, y: 2 } });
    await window.getByRole("button", { name: /^filter$/i }).click();
    await window.getByRole("button", { name: "+ Add filter", exact: true }).click();
    const rule = window.locator(".filter-rule").first();
    // An unfinished rule is neutral, matching Clay's builder: choosing a field
    // must not blank the table before the user enters the comparison value.
    await expect(window.getByText("2 of 2 rows")).toBeVisible();
    await expect(window.locator(".cell-value", { hasText: /^Globex$/ })).toBeVisible();
    await rule.locator(".filter-value-input").fill("Acme");
    await expect(window.getByText("1 of 2 rows")).toBeVisible();
    await expect(window.locator(".cell-value", { hasText: /^Acme$/ })).toBeVisible();
    await expect(window.locator(".cell-value", { hasText: /^Globex$/ })).toHaveCount(0);

    // A renderer reload uses the same per-table local preference.
    await window.locator(".grid-view-backdrop").click({ position: { x: 2, y: 2 } });
    await window.reload();
    await expect(window.locator(".grid-table")).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".grid-th.pinned-column", { hasText: "Domain" })).toBeVisible();
    await expect(window.locator(".cell-value", { hasText: /^Globex$/ })).toHaveCount(0);
    await expect(window.locator(".grid-view-count", { hasText: "1" })).toBeVisible();
  });

  test("offers hide, pin, and filter actions from the header menu", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    const company = window.locator(".grid-th", { hasText: "Company" });
    await expect(company).toBeVisible({ timeout: 20_000 });
    await company.click({ button: "right" });
    await expect(window.getByRole("button", { name: "Filter on this column" })).toBeVisible();
    await expect(window.getByRole("button", { name: "Pin column" })).toBeVisible();
    await expect(window.getByRole("button", { name: "Hide column" })).toBeVisible();
  });
});
