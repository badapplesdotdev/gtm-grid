// CRM sync (Attio) end-to-end tests — the "From your CRM" wizard, the synced-
// table status strip + sync log, and read-only synced columns, all against the
// mock cloud's `crm.*` procedures (e2e/mock/trpc.mjs).

import { test, expect, mockState, type Scenario } from "./fixtures";

/** Signed-in paid workspace with an Attio connection already made. */
const CONNECTED: Scenario = { signedIn: true, paid: true, crmConnected: true };

/** Open the new-table chooser from the sidebar add menu. */
async function openChooser(window: import("@playwright/test").Page): Promise<void> {
  await expect(window.locator('button[title="Add table or folder"]')).toBeVisible({ timeout: 20_000 });
  await window.locator('button[title="Add table or folder"]').click();
  await window.getByText("New table", { exact: true }).first().click();
}

/** Walk the wizard from the chooser through to the configure step (connected). */
async function openConfigureStep(window: import("@playwright/test").Page): Promise<void> {
  await openChooser(window);
  await window.getByText("From your CRM").click();
  await expect(window.locator(".crmw-modal")).toBeVisible();
  await window.locator(".crmw-crm-card", { hasText: "Attio" }).first().click();
  // Connected workspace skips straight past step 2 to Configure.
  await expect(window.locator(".crmw-source-grid")).toBeVisible();
}

test.describe("CRM sync — wizard", () => {
  test("the chooser offers 'From your CRM' and step 1 shows Attio + HubSpot (coming soon)", async ({ launchApp }) => {
    const { window } = await launchApp(CONNECTED);
    await openChooser(window);

    await expect(window.getByText("From your CRM")).toBeVisible();
    await window.getByText("From your CRM").click();

    await expect(window.locator(".crmw-modal")).toBeVisible();
    await expect(window.locator(".crmw-crm-card", { hasText: "Attio" }).first()).toBeVisible();
    const hubspot = window.locator(".crmw-crm-disabled", { hasText: "HubSpot" });
    await expect(hubspot).toBeVisible();
    await expect(hubspot.getByText("Coming soon")).toBeVisible();
    // The read-only reassurance from the design.
    await expect(window.getByText(/never writes back to your CRM/i)).toBeVisible();
  });

  test("without a connection, step 2 shows the read-only OAuth consent panel", async ({ launchApp }) => {
    const { window } = await launchApp({ signedIn: true, paid: true, crmConnected: false });
    await openChooser(window);
    await window.getByText("From your CRM").click();
    await window.locator(".crmw-crm-card", { hasText: "Attio" }).first().click();

    await expect(window.getByText("Connect your Attio account")).toBeVisible();
    await expect(window.getByText(/No write \/ delete permissions/i)).toBeVisible();
    await expect(window.getByRole("button", { name: /Connect with Attio/i })).toBeVisible();
  });

  test("configure step: sources, recommended fields with samples, estimate, dedupe options", async ({ launchApp }) => {
    const { window } = await launchApp(CONNECTED);
    await openConfigureStep(window);

    // Connected banner + source cards from crm.listSources.
    await expect(window.getByText(/connected by Morgan|Acme Attio/i).first()).toBeVisible();
    await expect(window.locator(".crmw-source", { hasText: "People" })).toBeVisible();
    await expect(window.locator(".crmw-source", { hasText: "Companies" })).toBeVisible();
    // Lists live under their own tab.
    await window.locator(".crmw-tab", { hasText: "Lists & views" }).click();
    await expect(window.locator(".crmw-source", { hasText: "MQLs — Q3" })).toBeVisible();
    await window.locator(".crmw-tab", { hasText: "Objects" }).click();

    // Selecting a source loads its fields (recommended pre-checked, samples shown).
    await window.locator(".crmw-source", { hasText: "People" }).click();
    await expect(window.locator(".crmw-field", { hasText: "Email addresses" })).toBeVisible();
    await expect(window.getByText("sarah.chen@vercel.com")).toBeVisible();
    await expect(window.getByText("Reset to recommended")).toBeVisible();

    // Dedupe options render with the design copy.
    await expect(window.getByText("Update existing")).toBeVisible();
    await expect(window.getByText("Skip existing")).toBeVisible();
    await expect(window.getByText("Always create")).toBeVisible();

    // The footer estimate comes from crm.estimate.
    await expect(window.locator(".crmw-footer")).toContainText("124");
  });

  test("Start sync creates the table + binding and lands on the synced grid with the strip", async ({ launchApp }) => {
    const { window } = await launchApp(CONNECTED);
    const tablesBefore = (await mockState()).tables.length;

    await openConfigureStep(window);
    await window.locator(".crmw-source", { hasText: "People" }).click();
    await expect(window.locator(".crmw-field", { hasText: "Email addresses" })).toBeVisible();
    await window.getByRole("button", { name: "Start sync" }).click();

    // Table + binding persisted in the mock…
    await expect.poll(async () => (await mockState()).tables.length).toBe(tablesBefore + 1);
    await expect.poll(async () => (await mockState()).crmBindings.length).toBe(1);

    // …and the synced grid renders the status strip with the pulled row.
    await expect(window.locator(".crm-strip")).toBeVisible({ timeout: 10_000 });
    await expect(window.locator(".crm-strip-title")).toContainText("Synced from Attio");
    await expect(window.locator(".cell-value", { hasText: "Sarah Chen" })).toBeVisible();
  });
});


/** A pre-seeded binding on the built-in "Leads" table (tbl_1), for scenarios
 *  that need a synced table without walking the wizard. */
function seededBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "crmb_seed",
    workspaceId: "ws_1",
    tableId: "tbl_1",
    provider: "attio",
    sourceKind: "object",
    sourceId: "people",
    sourceLabel: "People",
    columns: [],
    config: { filters: [], dedupeMode: "update", matchKeyAttr: null },
    schedule: "daily",
    enabled: true,
    pausedReason: null,
    lastSyncedAt: Date.now(),
    lastError: null,
    rowsSynced: 6,
    createdAt: Date.now(),
    ...overrides,
  };
}

test.describe("CRM sync — status strip & synced grid", () => {
  test("Sync now records a run that appears in the sync log", async ({ launchApp }) => {
    const { window } = await launchApp(CONNECTED);
    await openConfigureStep(window);
    await window.locator(".crmw-source", { hasText: "People" }).click();
    await expect(window.locator(".crmw-field", { hasText: "Email addresses" })).toBeVisible();
    await window.getByRole("button", { name: "Start sync" }).click();
    await expect(window.locator(".crm-strip")).toBeVisible({ timeout: 10_000 });

    await window.getByRole("button", { name: "Sync now" }).click();
    await expect.poll(async () => (await mockState()).crmRuns.length).toBe(1);

    // The log opens (it may already be open while syncing) and shows the run.
    const logToggle = window.getByRole("button", { name: "Sync log" });
    await logToggle.click();
    await expect(window.getByText(/2 new · 5 updated|2 new/).first()).toBeVisible({ timeout: 10_000 });
  });

  test("synced columns are read-only; user columns still edit", async ({ launchApp }) => {
    const { window } = await launchApp(CONNECTED);
    await openConfigureStep(window);
    await window.locator(".crmw-source", { hasText: "People" }).click();
    await expect(window.locator(".crmw-field", { hasText: "Email addresses" })).toBeVisible();
    await window.getByRole("button", { name: "Start sync" }).click();
    await expect(window.locator(".crm-strip")).toBeVisible({ timeout: 10_000 });

    // Clicking a synced cell must NOT open the editor.
    await window.locator(".cell-value", { hasText: "Sarah Chen" }).click();
    await expect(window.locator(".cell-input")).toHaveCount(0);

    // The context menu must not offer "Clear cell" on a synced column either —
    // clearing writes "" over CRM data (regression: the clear path originally
    // bypassed the read-only gating).
    await window.locator(".cell-value", { hasText: "Sarah Chen" }).click({ button: "right" });
    await expect(window.locator(".ctx-menu")).toBeVisible();
    await expect(window.locator(".ctx-item", { hasText: "Clear cell" })).toHaveCount(0);
    await window.locator(".ctx-backdrop").click(); // dismiss via backdrop

    // Sanity: an ordinary manual cell on the seeded "Leads" table still edits
    // AND still offers "Clear cell" (the gating is scoped to synced columns).
    await window.locator(".sidebar-item-name", { hasText: "Leads" }).first().click();
    await window.locator(".cell-value", { hasText: /^Acme$/ }).first().click({ button: "right" });
    await expect(window.locator(".ctx-item", { hasText: "Clear cell" })).toBeVisible();
    await window.locator(".ctx-backdrop").click(); // dismiss via backdrop
    await window.locator(".cell-value", { hasText: /^Acme$/ }).first().click();
    await expect(window.locator(".cell-input")).toBeVisible();
  });

  test("a background run shows the pulling state without clicking Sync now", async ({ launchApp }) => {
    const { window } = await launchApp({
      ...CONNECTED,
      crmBindings: [seededBinding({ lastSyncedAt: null })],
      crmRuns: [
        {
          id: "crmrun_bg",
          workspaceId: "ws_1",
          bindingId: "crmb_seed",
          tableId: "tbl_1",
          status: "running",
          trigger: "cron",
          rowsCreated: 240,
          rowsUpdated: 0,
          rowsSkipped: 0,
          rowsStaled: 0,
          fieldsDropped: null,
          error: null,
          startedAt: Date.now(),
          finishedAt: null,
        },
      ],
    });
    await window.locator(".sidebar-item-name", { hasText: "Leads" }).first().click();

    // The strip derives "syncing" from the server-side run — no local click.
    await expect(window.locator(".crm-strip")).toBeVisible({ timeout: 10_000 });
    await expect(window.locator(".crm-strip")).toContainText("Pulling records from Attio…");
    await expect(window.locator(".crm-strip")).toContainText("240 so far");
    await expect(window.getByRole("button", { name: /Syncing…|Sync now/ })).toBeDisabled();
  });

  test("a plan-lapsed binding shows the upgrade banner with View plans", async ({ launchApp }) => {
    const lapsedCopy = "Your plan doesn't include CRM sync right now. Upgrade to resume syncing.";
    const { window } = await launchApp({
      ...CONNECTED,
      crmBindings: [seededBinding({ pausedReason: "plan_lapsed", lastError: lapsedCopy })],
    });
    await window.locator(".sidebar-item-name", { hasText: "Leads" }).first().click();

    await expect(window.locator(".crm-strip")).toBeVisible({ timeout: 10_000 });
    const banner = window.locator(".crm-strip-banner");
    await expect(banner).toContainText(lapsedCopy);
    await expect(banner.getByRole("button", { name: "View plans" })).toBeVisible();
  });
});

test.describe("CRM sync — OAuth management (Tools → Attio)", () => {
  /** Open the Attio tool panel from the sidebar Tools section. */
  async function openAttioPanel(window: import("@playwright/test").Page): Promise<void> {
    await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    await window.locator(".ext-item-name", { hasText: /^Attio$/ }).first().click();
    await expect(window.locator(".crm-oauth-card")).toBeVisible({ timeout: 15_000 });
  }

  test("the panel separates the OAuth connection from the API key, with Reconnect + Disconnect", async ({ launchApp }) => {
    const { window } = await launchApp(CONNECTED);
    await openAttioPanel(window);

    // OAuth card reflects the sync connection…
    const card = window.locator(".crm-oauth-card");
    await expect(card).toContainText("CRM sync · OAuth connection");
    await expect(card).toContainText("Connected · Acme Attio");
    await expect(card.getByRole("button", { name: "Reconnect" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Disconnect" })).toBeVisible();
    // …and explains the API key is a separate concern (cell actions).
    await expect(card).toContainText("API key below is separate");
  });

  test("disconnect requires confirmation, flips to Not connected, and pauses synced tables", async ({ launchApp }) => {
    const { window } = await launchApp(CONNECTED);
    // Create a synced table first so the disconnect has something to pause.
    await openConfigureStep(window);
    await window.locator(".crmw-source", { hasText: "People" }).click();
    await expect(window.locator(".crmw-field", { hasText: "Email addresses" })).toBeVisible();
    await window.getByRole("button", { name: "Start sync" }).click();
    await expect(window.locator(".crm-strip")).toBeVisible({ timeout: 10_000 });

    await openAttioPanel(window);
    const card = window.locator(".crm-oauth-card");
    await card.getByRole("button", { name: "Disconnect" }).click();
    await card.getByRole("button", { name: "Confirm disconnect" }).click();

    await expect(card).toContainText("Not connected", { timeout: 10_000 });
    await expect(card).toContainText("1 synced table paused");
    await expect.poll(async () => (await mockState()).crmConnected).toBe(false);
    await expect.poll(async () => (await mockState()).crmBindings[0]?.pausedReason).toBe("auth_revoked");
    // The card offers the way back in.
    await expect(card.getByRole("button", { name: "Connect Attio" })).toBeVisible();
  });
});
