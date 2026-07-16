// ZoomInfo end-to-end coverage. The real Electron renderer talks to the stateful
// mock cloud/engine, which simulates OAuth credential storage and ZoomInfo API
// responses without requiring a live account, token, network call, or credits.

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
        name: "ZoomInfo contacts",
        type: "json",
        kind: "function",
        provider: "zoominfo",
        method: "searchContact",
        code: null,
        params: {
          "page[size]": 25,
          data: {
            type: "ContactSearch",
            attributes: { companyName: "{{Company}}" },
          },
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
        extensionId: "zoominfo",
        scope: "workspace",
        name: "ZoomInfo",
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

test.describe("ZoomInfo tool", () => {
  test("matches the Tools theme and connects a simulated OAuth token", async ({ launchApp }, testInfo) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    await window.locator(".sidebar-section-label", { hasText: "Tools" }).locator(".section-link").click();
    await expect(window.getByPlaceholder("Search tools")).toBeVisible();
    await window.getByPlaceholder("Search tools").fill("ZoomInfo");

    const card = window.locator(".browse-card", { hasText: "ZoomInfo" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("84 endpoints");
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
    await expect(window.locator(".detail-title", { hasText: "ZoomInfo" })).toBeVisible();
    await expect(window.locator(".detail-icon img.brand-img")).toBeVisible();
    await expect(window.getByText("Tool  ·  84 methods  ·  v1.0.0")).toBeVisible();
    await expect(window.getByText("No ZoomInfo credentials yet")).toBeVisible();
    await window.getByRole("button", { name: "Add connection" }).click();

    const tokenInput = window.getByPlaceholder("ZoomInfo OAuth access token");
    await expect(tokenInput).toBeVisible();
    await expect(window.getByText(/ZoomInfo OAuth access token · Cloud/)).toBeVisible();

    // Meaningful form edge: blank tokens are rejected in the real UI before the
    // mocked persistence layer is called.
    await window.getByRole("button", { name: "Save token" }).click();
    await expect(window.getByText("Enter OAuth access token")).toBeVisible();
    expect((await mockState()).credentials).toHaveLength(0);

    await tokenInput.fill("simulated-oauth-token");
    await window.getByRole("button", { name: "Save token" }).click();
    await expect(window.getByText("ZoomInfo connected")).toBeVisible();
    await expect(
      window.locator(".ext-item", { hasText: "ZoomInfo" }).locator(".ext-badge.connected"),
    ).toHaveText("connected");
    const methodsSection = window.locator(".detail-collapse-head", { hasText: "Available methods · 84" });
    await methodsSection.scrollIntoViewIfNeeded();
    await methodsSection.click();
    await expect(window.locator(".method-row", { hasText: "Search Contacts" })).toBeVisible();
    await expect.poll(async () => (await mockState()).credentials[0]?.extensionId).toBe("zoominfo");
    await expect.poll(async () => (await mockState()).credentials[0]?.secrets?.apiKey).toBe("simulated-oauth-token");

    await window.screenshot({ path: testInfo.outputPath("zoominfo-connected.png"), fullPage: true });
    expect(runtimeErrors).toEqual([]);
  });

  test("runs Search Contacts through the simulated API and persists results", async ({ launchApp }) => {
    const { window } = await launchApp(runScenario("simulated-oauth-token"));
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".grid-th", { hasText: "ZoomInfo contacts" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "Run ZoomInfo contacts" }).click();

    await expect.poll(async () => (await mockState()).zoomInfoCalls.length).toBe(2);
    const state = await mockState();
    expect(state.zoomInfoCalls[0]).toMatchObject({
      provider: "zoominfo",
      method: "searchContact",
      authorization: "Bearer simulated-oauth-token",
      query: { "page[size]": 25 },
      body: { data: { type: "ContactSearch", attributes: { companyName: "Acme" } } },
    });
    expect(state.zoomInfoCalls[1].body.data.attributes.companyName).toBe("Globex");
    expect(state.cells.row_1.col_3.status).toBe("done");
    expect(state.cells.row_2.col_3.status).toBe("done");
    // Production receives the cell writes through realtime. The hermetic mock
    // has no PartyKit socket, so reload once to read the persisted mock state.
    await window.reload();
    await expect(window.locator(".grid-th", { hasText: "ZoomInfo contacts" })).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".cell-status.ok", { hasText: "View data" })).toHaveCount(2);
    expect(runtimeErrors).toEqual([]);
  });

  test("surfaces a simulated expired-token failure in every affected row", async ({ launchApp }) => {
    const { window } = await launchApp(runScenario("invalid-token"));

    await expect(window.locator(".grid-th", { hasText: "ZoomInfo contacts" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "Run ZoomInfo contacts" }).click();

    await expect.poll(async () => (await mockState()).cells.row_1.col_3.status).toBe("error");
    await window.reload();
    await expect(window.locator(".grid-th", { hasText: "ZoomInfo contacts" })).toBeVisible({ timeout: 20_000 });
    await expect(window.locator('.cell-wrap[title*="OAuth access token invalid"]')).toHaveCount(2);
    await expect(window.locator(".cell-status.err", { hasText: "Status Code: 401" })).toHaveCount(2);
    const state = await mockState();
    expect(state.cells.row_2.col_3.error).toContain("HTTP 401");
    expect(state.zoomInfoCalls).toEqual([{ provider: "zoominfo", method: "searchContact", auth: "rejected" }]);
  });
});
