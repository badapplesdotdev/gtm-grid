// People Data Labs end-to-end coverage. The real Electron renderer talks only
// to the hermetic simulator, so tests consume no PDL credits and need no key.

import type { Page } from "@playwright/test";
import { test, expect, mockState, type Scenario } from "./fixtures";

const baseColumns = [
  { _id: "col_1", tableId: "tbl_1", name: "Company", type: "text", kind: "manual", provider: null, method: null, code: null, params: null, condition: null, config: null },
  { _id: "col_2", tableId: "tbl_1", name: "Domain", type: "text", kind: "manual", provider: null, method: null, code: null, params: null, condition: null, config: null },
  { _id: "col_3", tableId: "tbl_1", name: "Email", type: "text", kind: "manual", provider: null, method: null, code: null, params: null, condition: null, config: null },
];

function runScenario(token: string): Scenario {
  return {
    signedIn: true,
    paid: true,
    columns: [
      ...baseColumns,
      {
        _id: "col_4",
        tableId: "tbl_1",
        name: "PDL person",
        type: "json",
        kind: "function",
        provider: "peopledatalabs",
        method: "getPersonEnrichment",
        code: null,
        params: { email: "{{Email}}", min_likelihood: 8, include_if_matched: true },
        condition: null,
        config: null,
      },
    ],
    cells: {
      row_1: {
        col_1: { value: "Acme", status: "done", error: null },
        col_2: { value: "acme.com", status: "done", error: null },
        col_3: { value: "ada@acme.com", status: "done", error: null },
        col_4: { value: null, status: "empty", error: null },
      },
      row_2: {
        col_1: { value: "Globex", status: "done", error: null },
        col_2: { value: "globex.com", status: "done", error: null },
        col_3: { value: "grace@globex.com", status: "done", error: null },
        col_4: { value: null, status: "empty", error: null },
      },
    },
    credentials: [{
      workspaceId: "ws_1",
      extensionId: "peopledatalabs",
      scope: "workspace",
      name: "People Data Labs",
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

test.describe("People Data Labs tool", () => {
  test("matches the Tools theme, renders the official logo, and connects a simulated key", async ({ launchApp }, testInfo) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    await window.locator(".sidebar-section-label", { hasText: "Tools" }).locator(".section-link").click();
    const search = window.getByPlaceholder("Search tools");
    await expect(search).toBeVisible();
    await search.fill("People Data Labs");

    const card = window.locator(".browse-card", { hasText: "People Data Labs" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("27 production operations");
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
    await expect(window.locator(".detail-title", { hasText: "People Data Labs" })).toBeVisible();
    await expect(window.locator(".detail-icon img.brand-img")).toBeVisible();
    await expect(window.getByText("Tool  ·  27 methods  ·  v1.0.0")).toBeVisible();
    await expect(window.getByText("No People Data Labs credentials yet")).toBeVisible();
    await window.getByRole("button", { name: "Add connection" }).click();

    const keyInput = window.getByPlaceholder("People Data Labs API key");
    await expect(keyInput).toBeVisible();
    await expect(window.getByText(/People Data Labs API key · Cloud/)).toBeVisible();
    await window.getByRole("button", { name: "Save key" }).click();
    await expect(window.getByText("Enter API key")).toBeVisible();
    expect((await mockState()).credentials).toHaveLength(0);

    await keyInput.fill("pdl_simulated_key");
    await window.getByRole("button", { name: "Save key" }).click();
    await expect(window.getByText("People Data Labs connected")).toBeVisible();
    const methodsSection = window.locator(".detail-collapse-head", { hasText: "Available methods · 27" });
    await methodsSection.scrollIntoViewIfNeeded();
    await methodsSection.click();
    await expect(window.locator(".method-row", { hasText: "Enrich Person (GET)" })).toBeVisible();
    await expect(window.locator(".method-row", { hasText: "Bulk Person Enrichment" })).toBeVisible();
    await expect(window.locator(".method-row", { hasText: "Search Job Postings" })).toBeVisible();
    await expect(window.locator(".method-row", { hasText: "Get Subject Requests" })).toBeVisible();
    await expect.poll(async () => (await mockState()).credentials[0]?.extensionId).toBe("peopledatalabs");
    await expect.poll(async () => (await mockState()).credentials[0]?.secrets?.apiKey).toBe("pdl_simulated_key");

    await window.screenshot({ path: testInfo.outputPath("peopledatalabs-connected.png"), fullPage: true });
    expect(runtimeErrors).toEqual([]);
  });

  test("runs Person Enrichment through the simulated API and persists both row results", async ({ launchApp }) => {
    const { window } = await launchApp(runScenario("pdl_simulated_key"));
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".grid-th", { hasText: "PDL person" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "Run PDL person" }).click();
    await expect.poll(async () => (await mockState()).peopleDataLabsCalls.length).toBe(2);
    const state = await mockState();
    expect(state.peopleDataLabsCalls[0]).toMatchObject({
      provider: "peopledatalabs",
      method: "getPersonEnrichment",
      headers: { "X-Api-Key": "pdl_simulated_key" },
      query: { email: "ada@acme.com", min_likelihood: 8, include_if_matched: true },
    });
    expect(state.peopleDataLabsCalls[1].query.email).toBe("grace@globex.com");
    expect(state.peopleDataLabsCalls[0].headers["X-Api-Key"]).not.toContain("Bearer");
    expect(state.cells.row_1.col_4.value.data.full_name).toBe("Ada Lovelace");
    expect(state.cells.row_2.col_4.value.data.full_name).toBe("Grace Hopper");

    await window.reload();
    await expect(window.locator(".grid-th", { hasText: "PDL person" })).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".cell-status.ok", { hasText: "Status Code: 200" })).toHaveCount(2);
    expect(runtimeErrors).toEqual([]);
  });

  test("surfaces a simulated invalid-key failure in every affected row", async ({ launchApp }) => {
    const { window } = await launchApp(runScenario("invalid-token"));
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".grid-th", { hasText: "PDL person" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "Run PDL person" }).click();
    await expect.poll(async () => (await mockState()).cells.row_1.col_4.status).toBe("error");
    await window.reload();
    await expect(window.locator(".grid-th", { hasText: "PDL person" })).toBeVisible({ timeout: 20_000 });
    await expect(window.locator('.cell-wrap[title*="API key invalid"]')).toHaveCount(2);
    await expect(window.locator(".cell-status.err", { hasText: "Status Code: 401" })).toHaveCount(2);
    const state = await mockState();
    expect(state.cells.row_2.col_4.error).toContain("HTTP 401");
    expect(state.peopleDataLabsCalls).toEqual([{ provider: "peopledatalabs", method: "getPersonEnrichment", auth: "rejected" }]);
    expect(runtimeErrors).toEqual([]);
  });
});
