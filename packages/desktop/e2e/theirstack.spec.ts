// TheirStack end-to-end coverage. The real Electron renderer talks only to the
// hermetic simulator, so no live API key, credits, webhook, or external mutation
// is needed to validate connection, request mapping, persistence, and errors.

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
        name: "TheirStack jobs",
        type: "json",
        kind: "function",
        provider: "theirstack",
        method: "search_jobs_v1",
        code: null,
        params: {
          company_domain_or: ["{{Domain}}"],
          posted_at_max_age_days: 30,
          job_title_or: ["VP Sales"],
          limit: 10,
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
    credentials: [{
      workspaceId: "ws_1",
      extensionId: "theirstack",
      scope: "workspace",
      name: "TheirStack",
      secrets: { apiKey: token },
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

test.describe("TheirStack tool", () => {
  test("matches the Tools theme, renders the official logo, and connects a simulated key", async ({ launchApp }, testInfo) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    await window.locator(".sidebar-section-label", { hasText: "Tools" }).locator(".section-link").click();
    const search = window.getByPlaceholder("Search tools");
    await expect(search).toBeVisible();
    await search.fill("TheirStack");

    const card = window.locator(".browse-card", { hasText: "TheirStack" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("51 active endpoints");
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
    await expect(window.locator(".detail-title", { hasText: "TheirStack" })).toBeVisible();
    await expect(window.locator(".detail-icon img.brand-img")).toBeVisible();
    await expect(window.getByText("Tool  ·  51 methods  ·  v1.0.0")).toBeVisible();
    await expect(window.getByText("No TheirStack credentials yet")).toBeVisible();
    await window.getByRole("button", { name: "Add connection" }).click();

    const keyInput = window.getByPlaceholder("TheirStack API key");
    await expect(keyInput).toBeVisible();
    await expect(window.getByText(/TheirStack API key · Cloud/)).toBeVisible();
    await window.getByRole("button", { name: "Save key" }).click();
    await expect(window.getByText("Enter API key")).toBeVisible();
    expect((await mockState()).credentials).toHaveLength(0);

    await keyInput.fill("their_simulated_key");
    await window.getByRole("button", { name: "Save key" }).click();
    await expect(window.getByText("TheirStack connected")).toBeVisible();
    const methodsSection = window.locator(".detail-collapse-head", { hasText: "Available methods · 51" });
    await methodsSection.scrollIntoViewIfNeeded();
    await methodsSection.click();
    await expect(window.locator(".method-row", { hasText: "Job Search" })).toBeVisible();
    await expect(window.locator(".method-row", { hasText: "Technographics" })).toBeVisible();
    await expect(window.locator(".method-row", { hasText: "List All Webhooks" })).toBeVisible();
    await expect.poll(async () => (await mockState()).credentials[0]?.extensionId).toBe("theirstack");
    await expect.poll(async () => (await mockState()).credentials[0]?.secrets?.apiKey).toBe("their_simulated_key");

    await window.screenshot({ path: testInfo.outputPath("theirstack-connected.png"), fullPage: true });
    expect(runtimeErrors).toEqual([]);
  });

  test("runs Job Search through the simulated API and persists both row results", async ({ launchApp }) => {
    const { window } = await launchApp(runScenario("their_simulated_key"));
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".grid-th", { hasText: "TheirStack jobs" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "Run TheirStack jobs" }).click();

    await expect.poll(async () => (await mockState()).theirStackCalls.length).toBe(2);
    const state = await mockState();
    expect(state.theirStackCalls[0]).toMatchObject({
      provider: "theirstack",
      method: "search_jobs_v1",
      authorization: "Bearer their_simulated_key",
      body: {
        company_domain_or: ["acme.com"],
        posted_at_max_age_days: 30,
        job_title_or: ["VP Sales"],
        limit: 10,
      },
    });
    expect(state.theirStackCalls[1].body.company_domain_or).toEqual(["globex.com"]);
    expect(state.cells.row_1.col_3.status).toBe("done");
    expect(state.cells.row_2.col_3.status).toBe("done");

    await window.reload();
    await expect(window.locator(".grid-th", { hasText: "TheirStack jobs" })).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".cell-status.ok", { hasText: "View data" })).toHaveCount(2);
    expect(runtimeErrors).toEqual([]);
  });

  test("surfaces a simulated invalid-key failure in every affected row", async ({ launchApp }) => {
    const { window } = await launchApp(runScenario("invalid-token"));
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".grid-th", { hasText: "TheirStack jobs" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "Run TheirStack jobs" }).click();

    await expect.poll(async () => (await mockState()).cells.row_1.col_3.status).toBe("error");
    await window.reload();
    await expect(window.locator(".grid-th", { hasText: "TheirStack jobs" })).toBeVisible({ timeout: 20_000 });
    await expect(window.locator('.cell-wrap[title*="API key invalid"]')).toHaveCount(2);
    await expect(window.locator(".cell-status.err", { hasText: "Status Code: 401" })).toHaveCount(2);
    const state = await mockState();
    expect(state.cells.row_2.col_3.error).toContain("HTTP 401");
    expect(state.theirStackCalls).toEqual([{ provider: "theirstack", method: "search_jobs_v1", auth: "rejected" }]);
    expect(runtimeErrors).toEqual([]);
  });
});
