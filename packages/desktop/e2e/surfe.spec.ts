// Surfe end-to-end coverage. Electron talks only to the stateful local mock,
// which simulates credential storage and Surfe responses without a live key,
// external request, quota use, or provider credit charge.

import type { Page } from "@playwright/test";
import { test, expect, mockState, type Scenario } from "./fixtures";

const baseColumns = [
  { _id: "col_1", tableId: "tbl_1", name: "Company", type: "text", kind: "manual", provider: null, method: null, code: null, params: null, condition: null, config: null },
  { _id: "col_2", tableId: "tbl_1", name: "Domain", type: "text", kind: "manual", provider: null, method: null, code: null, params: null, condition: null, config: null },
];

function runScenario(token: string): Scenario {
  return {
    signedIn: true,
    paid: true,
    columns: [
      ...baseColumns,
      {
        _id: "col_3",
        tableId: "tbl_1",
        name: "Surfe people",
        type: "json",
        kind: "function",
        provider: "surfe",
        method: "searchPeople",
        code: null,
        params: {
          limit: 10,
          companies: { domains: ["{{Domain}}"] },
          people: { jobTitles: ["VP Sales"] },
        },
        condition: null,
        config: null,
      },
    ],
    cells: {
      row_1: {
        col_1: { value: "Acme", status: "done", error: null },
        col_2: { value: "acme.com", status: "done", error: null },
        col_3: { value: null, status: "empty", error: null },
      },
      row_2: {
        col_1: { value: "Globex", status: "done", error: null },
        col_2: { value: "globex.com", status: "done", error: null },
        col_3: { value: null, status: "empty", error: null },
      },
    },
    credentials: [
      {
        workspaceId: "ws_1",
        extensionId: "surfe",
        scope: "workspace",
        name: "Surfe",
        secrets: { apiKey: token },
      },
    ],
  };
}

function collectRuntimeErrors(window: Page): string[] {
  const errors: string[] = [];
  window.on("pageerror", (error) => errors.push(error.message));
  window.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test.describe("Surfe tool", () => {
  test("matches the Tools theme and connects a simulated API key", async ({ launchApp }, testInfo) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    await window.locator(".sidebar-section-label", { hasText: "Tools" }).locator(".section-link").click();
    const search = window.getByPlaceholder("Search tools");
    await expect(search).toBeVisible();
    await search.fill("Surfe");

    const card = window.locator(".browse-card", { hasText: "Surfe" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("12 endpoints");
    const cardLogo = card.locator("img.brand-img");
    await expect(cardLogo).toBeVisible();
    expect(await cardLogo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expect(card.locator(".brand-fallback")).toHaveCount(0);
    const cardStyle = await card.evaluate((element) => {
      const style = getComputedStyle(element);
      return { borderStyle: style.borderStyle, borderRadius: style.borderRadius, fontFamily: style.fontFamily };
    });
    expect(cardStyle.borderStyle).toBe("solid");
    expect(parseFloat(cardStyle.borderRadius)).toBeGreaterThan(4);
    expect(cardStyle.fontFamily).toBeTruthy();

    await card.click();
    await expect(window.locator(".detail-title", { hasText: "Surfe" })).toBeVisible();
    await expect(window.locator(".detail-icon img.brand-img")).toBeVisible();
    await expect(window.getByText("Tool  ·  12 methods  ·  v1.0.0")).toBeVisible();
    await expect(window.getByText("No Surfe credentials yet")).toBeVisible();
    await window.getByRole("button", { name: "Add connection" }).click();

    const keyInput = window.getByPlaceholder("Surfe API key");
    await expect(keyInput).toBeVisible();
    await expect(window.getByText(/Surfe API key · Cloud/)).toBeVisible();
    await window.getByRole("button", { name: "Save key" }).click();
    await expect(window.getByText("Enter API key")).toBeVisible();
    expect((await mockState()).credentials).toHaveLength(0);

    await keyInput.fill("simulated-surfe-key");
    await window.getByRole("button", { name: "Save key" }).click();
    await expect(window.getByText("Surfe connected")).toBeVisible();
    const methodsSection = window.locator(".detail-collapse-head", { hasText: "Available methods · 12" });
    await methodsSection.scrollIntoViewIfNeeded();
    await methodsSection.click();
    await expect(window.locator(".method-row", { hasText: "Search People" })).toBeVisible();
    await expect(window.locator(".method-row", { hasText: "Get Filters" })).toBeVisible();
    await expect.poll(async () => (await mockState()).credentials[0]?.extensionId).toBe("surfe");
    await expect.poll(async () => (await mockState()).credentials[0]?.secrets?.apiKey).toBe("simulated-surfe-key");

    await window.screenshot({ path: testInfo.outputPath("surfe-connected.png"), fullPage: true });
    expect(runtimeErrors).toEqual([]);
  });

  test("runs Search People through the simulated API and persists results", async ({ launchApp }) => {
    const { window } = await launchApp(runScenario("simulated-surfe-key"));
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".grid-th", { hasText: "Surfe people" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "Run Surfe people" }).click();

    await expect.poll(async () => (await mockState()).surfeCalls.length).toBe(2);
    const state = await mockState();
    expect(state.surfeCalls[0]).toMatchObject({
      provider: "surfe",
      method: "searchPeople",
      authorization: "Bearer simulated-surfe-key",
      body: {
        limit: 10,
        companies: { domains: ["acme.com"] },
        people: { jobTitles: ["VP Sales"] },
      },
    });
    expect(state.surfeCalls[1].body.companies.domains).toEqual(["globex.com"]);
    expect(state.cells.row_1.col_3.status).toBe("done");
    expect(state.cells.row_2.col_3.status).toBe("done");

    // The production renderer receives writes over realtime; reload lets the
    // hermetic mock expose its persisted state without a PartyKit socket.
    await window.reload();
    await expect(window.locator(".grid-th", { hasText: "Surfe people" })).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".cell-status.ok", { hasText: "View data" })).toHaveCount(2);
    expect(runtimeErrors).toEqual([]);
  });

  test("surfaces a simulated invalid-key failure in every affected row", async ({ launchApp }) => {
    const { window } = await launchApp(runScenario("invalid-token"));
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".grid-th", { hasText: "Surfe people" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "Run Surfe people" }).click();

    await expect.poll(async () => (await mockState()).cells.row_1.col_3.status).toBe("error");
    await window.reload();
    await expect(window.locator(".grid-th", { hasText: "Surfe people" })).toBeVisible({ timeout: 20_000 });
    await expect(window.locator('.cell-wrap[title*="API key invalid"]')).toHaveCount(2);
    await expect(window.locator(".cell-status.err", { hasText: "Status Code: 401" })).toHaveCount(2);
    const state = await mockState();
    expect(state.cells.row_2.col_3.error).toContain("HTTP 401");
    expect(state.surfeCalls).toEqual([{ provider: "surfe", method: "searchPeople", auth: "rejected" }]);
    expect(runtimeErrors).toEqual([]);
  });
});
