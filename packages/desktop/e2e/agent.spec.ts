// Agent-panel E2E — agent behaviours, skills (gtmgrid MCP tools) and the streamed
// turn lifecycle, driven by the mock's scripted `/api/agent/chat` SSE stream.

import { expect, test, mockState } from "./fixtures";

test.describe("Agent panel — behaviours, skills & MCP tools", () => {
  test("renders the provider tabs with the agent installed", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".agent-panel")).toBeVisible({ timeout: 20_000 });
    await expect(window.getByRole("button", { name: /^claude$/i })).toBeVisible();
    await expect(window.getByRole("button", { name: /^codex$/i })).toBeVisible();
    await expect(window.getByRole("button", { name: /^cursor$/i })).toBeVisible();
  });

  test("a turn streams text and renders the gtmgrid MCP tool calls (skills) + their results", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".agent-panel")).toBeVisible({ timeout: 20_000 });

    const composer = window.locator(".agent-input textarea");
    await composer.fill("Enrich the Leads table");
    await composer.press("Enter");

    // Streamed assistant text.
    await expect(window.getByText(/Reading the Leads table/i)).toBeVisible({ timeout: 15_000 });
    // The agent's MCP tools / skills, shown by their bare gtmgrid names.
    await expect(window.locator(".tc-name", { hasText: "get_table" })).toBeVisible();
    await expect(window.locator(".tc-name", { hasText: "add_rows" })).toBeVisible();
    // The final response (the streamed turn completed).
    await expect(window.getByText(/Done — enriched the Leads table/i)).toBeVisible({ timeout: 15_000 });
    // Tool RESULT lives in the (collapsed) tool card — expand it to verify.
    await window.locator(".tc-row", { hasText: "get_table" }).first().click();
    await expect(window.getByText(/Leads — 2 rows/).first()).toBeVisible();
  });

  test("scopes a goal to the AUTO-DEFAULTED table — no manual click — so the agent never invents a new one", async ({ launchApp }) => {
    // Regression (TRI: a goal made a NEW table). The app auto-selects the first
    // table on open; the active-table context must propagate to the chat request
    // (preamble's "Active table" hint + the MCP's hard `cloud.tableId` default)
    // WITHOUT the user ever clicking a table. The mock seeds one table, "Leads".
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".agent-panel")).toBeVisible({ timeout: 20_000 });

    // The agent panel shows it is scoped to the auto-defaulted table — no click.
    await expect(window.locator(".agent-context-chip", { hasText: "Leads" })).toBeVisible({ timeout: 20_000 });

    const composer = window.locator(".agent-input textarea");
    await composer.fill("/goal find 5 fintech companies and their domains");
    await composer.press("Enter");
    // Wait until the turn actually reached the server (the streamed reply renders).
    await expect(window.getByText(/Reading the Leads table/i)).toBeVisible({ timeout: 15_000 });

    // The request the renderer sent carries the active table on BOTH channels:
    //  • context.tableName → the preamble's "Active table … operate on this one"
    //  • cloud.tableId     → the MCP default so bare table refs resolve to it
    const state = await mockState();
    expect(state.lastChat?.context?.tableName).toBe("Leads");
    expect(state.lastChat?.cloud?.tableId).toBe("tbl_1");
  });

  test("an ask_user_question event replaces the composer with answer cards", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true });
    await expect(window.locator(".agent-panel")).toBeVisible({ timeout: 20_000 });

    const composer = window.locator(".agent-input textarea");
    await composer.fill("which provider should I use?");
    await composer.press("Enter");

    // The agent surfaced an option pick — answer cards render with the provided
    // options (asserted by the option labels, which are unique to the ask card).
    await expect(window.locator(".agent-ask-option-label", { hasText: "Exa" })).toBeVisible({ timeout: 15_000 });
    await expect(window.locator(".agent-ask-option-label", { hasText: "Trigify" })).toBeVisible();
  });
});
