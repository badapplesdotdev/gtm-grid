// Linear end-to-end coverage. Electron uses the stateful local simulator so
// authentication, GraphQL request construction, cell persistence, errors, and
// themed UI are covered without a real Linear key or live workspace mutation.

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
        name: "Linear issues",
        type: "json",
        kind: "function",
        provider: "linear",
        method: "query_issues",
        code: null,
        params: { first: 10, filter: { title: { contains: "{{Company}}" } } },
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
      extensionId: "linear",
      scope: "workspace",
      name: "Linear",
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

test.describe("Linear tool", () => {
  test("matches the Tools theme, shows its logo, and connects a simulated personal key", async ({ launchApp }, testInfo) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    await window.locator(".sidebar-section-label", { hasText: "Tools" }).locator(".section-link").click();
    const search = window.getByPlaceholder("Search tools");
    await expect(search).toBeVisible();
    await search.fill("Linear");

    const card = window.locator(".browse-card", { hasText: "Linear" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("516 active GraphQL operations");
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
    await expect(window.locator(".detail-title", { hasText: "Linear" })).toBeVisible();
    await expect(window.locator(".detail-icon img.brand-img")).toBeVisible();
    await expect(window.getByText("Tool  ·  517 methods  ·  v1.0.0")).toBeVisible();
    await expect(window.getByText("No Linear credentials yet")).toBeVisible();
    await window.getByRole("button", { name: "Add connection" }).click();

    const keyInput = window.getByPlaceholder("Linear personal API key");
    await expect(keyInput).toBeVisible();
    await expect(window.getByText(/Linear personal API key · Cloud/)).toBeVisible();
    await window.getByRole("button", { name: "Save key" }).click();
    await expect(window.getByText("Enter personal API key")).toBeVisible();
    expect((await mockState()).credentials).toHaveLength(0);

    await keyInput.fill("lin_api_simulated");
    await window.getByRole("button", { name: "Save key" }).click();
    await expect(window.getByText("Linear connected")).toBeVisible();
    const methodsSection = window.locator(".detail-collapse-head", { hasText: "Available methods · 517" });
    await methodsSection.scrollIntoViewIfNeeded();
    await methodsSection.click();
    await expect(window.locator(".method-row", { hasText: "Get Issues" })).toBeVisible();
    await expect(window.locator(".method-row", { hasText: "Run Issue Create" })).toBeVisible();
    await expect.poll(async () => (await mockState()).credentials[0]?.extensionId).toBe("linear");
    await expect.poll(async () => (await mockState()).credentials[0]?.secrets?.apiKey).toBe("lin_api_simulated");

    await window.screenshot({ path: testInfo.outputPath("linear-connected.png"), fullPage: true });
    expect(runtimeErrors).toEqual([]);
  });

  test("runs an issues query through simulated GraphQL and persists results", async ({ launchApp }) => {
    const { window } = await launchApp(runScenario("lin_api_simulated"));
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".grid-th", { hasText: "Linear issues" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "Run Linear issues" }).click();

    await expect.poll(async () => (await mockState()).linearCalls.length).toBe(2);
    const state = await mockState();
    expect(state.linearCalls[0]).toMatchObject({
      provider: "linear",
      method: "query_issues",
      authorization: "lin_api_simulated",
      graphql: {
        field: "issues",
        variables: { first: 10, filter: { title: { contains: "Acme" } } },
      },
    });
    expect(state.linearCalls[1].graphql.variables.filter.title.contains).toBe("Globex");
    expect(state.linearCalls[0].authorization).not.toContain("Bearer");
    expect(state.cells.row_1.col_3.status).toBe("done");
    expect(state.cells.row_2.col_3.status).toBe("done");

    await window.reload();
    await expect(window.locator(".grid-th", { hasText: "Linear issues" })).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".cell-status.ok", { hasText: "View data" })).toHaveCount(2);
    expect(runtimeErrors).toEqual([]);
  });

  test("surfaces a simulated invalid personal-key failure in every row", async ({ launchApp }) => {
    const { window } = await launchApp(runScenario("invalid-token"));
    const runtimeErrors = collectRuntimeErrors(window);

    await expect(window.locator(".grid-th", { hasText: "Linear issues" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "Run Linear issues" }).click();

    await expect.poll(async () => (await mockState()).cells.row_1.col_3.status).toBe("error");
    await window.reload();
    await expect(window.locator(".grid-th", { hasText: "Linear issues" })).toBeVisible({ timeout: 20_000 });
    await expect(window.locator('.cell-wrap[title*="personal API key invalid"]')).toHaveCount(2);
    await expect(window.locator(".cell-status.err", { hasText: "Status Code: 401" })).toHaveCount(2);
    const state = await mockState();
    expect(state.cells.row_2.col_3.error).toContain("HTTP 401");
    expect(state.linearCalls).toEqual([{ provider: "linear", method: "query_issues", auth: "rejected" }]);
    expect(runtimeErrors).toEqual([]);
  });
});
