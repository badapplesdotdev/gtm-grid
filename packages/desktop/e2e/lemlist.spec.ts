// Lemlist end-to-end coverage. The Electron renderer talks only to the hermetic
// simulator, so no live API key, campaign mutation, message, or credit is used.

import type { Page } from "@playwright/test";
import { test, expect, mockState, type Scenario } from "./fixtures";

const baseColumns = [
  { _id: "col_1", tableId: "tbl_1", name: "Company", type: "text", kind: "manual", provider: null, method: null, code: null, params: null, condition: null, config: null },
  { _id: "col_2", tableId: "tbl_1", name: "Domain", type: "text", kind: "manual", provider: null, method: null, code: null, params: null, condition: null, config: null },
  { _id: "col_3", tableId: "tbl_1", name: "Campaign ID", type: "text", kind: "manual", provider: null, method: null, code: null, params: null, condition: null, config: null },
];

function runScenario(token: string): Scenario {
  return {
    signedIn: true,
    paid: true,
    columns: [
      ...baseColumns,
      {
        _id: "col_4", tableId: "tbl_1", name: "Lemlist campaign", type: "json", kind: "function",
        provider: "lemlist", method: "getCampaign", code: null,
        params: { campaignId: "{{Campaign ID}}" }, condition: null, config: null,
      },
    ],
    cells: {
      row_1: {
        col_1: { value: "Acme", status: "done", error: null },
        col_2: { value: "acme.com", status: "done", error: null },
        col_3: { value: "cam_acme", status: "done", error: null },
        col_4: { value: null, status: "empty", error: null },
      },
      row_2: {
        col_1: { value: "Globex", status: "done", error: null },
        col_2: { value: "globex.com", status: "done", error: null },
        col_3: { value: "cam_globex", status: "done", error: null },
        col_4: { value: null, status: "empty", error: null },
      },
    },
    credentials: [{
      workspaceId: "ws_1", extensionId: "lemlist", scope: "workspace",
      name: "Lemlist", secrets: { apiKey: token },
    }],
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

test.describe("Lemlist tool", () => {
  test("matches the Tools theme, renders the official logo, and connects a simulated key", async ({ launchApp }, testInfo) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    await window.locator(".sidebar-section-label", { hasText: "Tools" }).locator(".section-link").click();
    const search = window.getByPlaceholder("Search tools");
    await search.fill("Lemlist");
    const card = window.locator(".browse-card", { hasText: "Lemlist" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("140 operations");
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
    await expect(window.locator(".detail-title", { hasText: "Lemlist" })).toBeVisible();
    await expect(window.locator(".detail-icon img.brand-img")).toBeVisible();
    await expect(window.getByText("Tool  ·  140 methods  ·  v1.0.0")).toBeVisible();
    await expect(window.getByText("No Lemlist credentials yet")).toBeVisible();
    await window.getByRole("button", { name: "Add connection" }).click();
    const keyInput = window.getByPlaceholder("Lemlist API key");
    await expect(keyInput).toBeVisible();
    await window.getByRole("button", { name: "Save key" }).click();
    await expect(window.getByText("Enter API key")).toBeVisible();
    expect((await mockState()).credentials).toHaveLength(0);

    await keyInput.fill("lem_simulated_key");
    await window.getByRole("button", { name: "Save key" }).click();
    await expect(window.getByText("Lemlist connected")).toBeVisible();
    const methodsSection = window.locator(".detail-collapse-head", { hasText: "Available methods · 140" });
    await methodsSection.scrollIntoViewIfNeeded();
    await methodsSection.click();
    await expect(window.locator(".method-row", { hasText: "Get Campaign" }).first()).toBeVisible();
    await expect(window.locator(".method-row", { hasText: "Bulk Enrich Data" })).toBeVisible();
    await expect(window.locator(".method-row", { hasText: "Send Email" })).toBeVisible();
    await expect(window.locator(".method-row", { hasText: "Add Webhook" })).toBeVisible();
    await expect.poll(async () => (await mockState()).credentials[0]?.extensionId).toBe("lemlist");
    await expect.poll(async () => (await mockState()).credentials[0]?.secrets?.apiKey).toBe("lem_simulated_key");

    await window.screenshot({ path: testInfo.outputPath("lemlist-connected.png"), fullPage: true });
    expect(runtimeErrors).toEqual([]);
  });

  test("runs Get Campaign with Basic auth and persists both row results", async ({ launchApp }) => {
    const { window } = await launchApp(runScenario("lem_simulated_key"));
    const runtimeErrors = collectRuntimeErrors(window);
    await expect(window.locator(".grid-th", { hasText: "Lemlist campaign" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "Run Lemlist campaign" }).click();
    await expect.poll(async () => (await mockState()).lemlistCalls.length).toBe(2);
    const state = await mockState();
    expect(state.lemlistCalls[0]).toEqual({
      provider: "lemlist", method: "getCampaign",
      authorization: `Basic ${Buffer.from(":lem_simulated_key").toString("base64")}`,
      path: "/campaigns/cam_acme",
    });
    expect(state.lemlistCalls[1].path).toBe("/campaigns/cam_globex");
    expect(state.lemlistCalls[0].authorization).not.toContain("Bearer");
    expect(state.cells.row_1.col_4.value.name).toBe("Acme outbound");
    expect(state.cells.row_2.col_4.value.name).toBe("Globex expansion");

    await window.reload();
    await expect(window.locator(".grid-th", { hasText: "Lemlist campaign" })).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".cell-status.ok", { hasText: "View data" })).toHaveCount(2);
    expect(runtimeErrors).toEqual([]);
  });

  test("surfaces a simulated invalid-key failure in every affected row", async ({ launchApp }) => {
    const { window } = await launchApp(runScenario("invalid-token"));
    const runtimeErrors = collectRuntimeErrors(window);
    await expect(window.locator(".grid-th", { hasText: "Lemlist campaign" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "Run Lemlist campaign" }).click();
    await expect.poll(async () => (await mockState()).cells.row_1.col_4.status).toBe("error");
    await window.reload();
    await expect(window.locator('.cell-wrap[title*="API key invalid"]')).toHaveCount(2);
    await expect(window.locator(".cell-status.err", { hasText: "Status Code: 401" })).toHaveCount(2);
    const state = await mockState();
    expect(state.lemlistCalls).toEqual([{ provider: "lemlist", method: "getCampaign", auth: "rejected" }]);
    expect(runtimeErrors).toEqual([]);
  });
});
