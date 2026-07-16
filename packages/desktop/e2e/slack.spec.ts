/**
 * Slack OAuth connect journey, end to end in the real Electron app.
 *
 * Modelled on `crm.spec.ts` — which is the point: `OAuthConnectCard` now serves
 * a CRM and a plain connector, so the same journey must work for a provider with
 * no sync bindings, no sources, and no API key beside it.
 *
 * WHY THIS ASSERTS THE AUTHORIZE URL RATHER THAN DRIVING SLACK:
 * Slack's consent screen is not scriptable in CI (real account, real 2FA,
 * bot-detection). The valuable, checkable claim is the one thing we control —
 * that the desktop hands the SYSTEM BROWSER a correct authorize URL, and that
 * the UI converges once the connection lands. The callback half is covered
 * offline by `apps/web/app/api/oauth/slack/callback/route.test.ts`.
 *
 * `openExternal` is captured via the mock cloud rather than really opening a
 * browser — asserting the URL is the assertion; launching Chrome is not.
 */

import { expect, test } from "./fixtures";

/** A workspace with Slack already connected. */
const CONNECTED = { slackConnected: true };
/** A deployment with no Slack app at all (self-host without SLACK_CLIENT_ID). */
const UNCONFIGURED = { slackConfigured: false };

/** Open the Slack tool panel from the sidebar Tools section. */
async function openSlackPanel(window: import("@playwright/test").Page): Promise<void> {
  await expect(window.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
  await window.locator(".ext-item-name", { hasText: /^Slack$/ }).first().click();
  await expect(window.locator(".crm-oauth-card")).toBeVisible({ timeout: 15_000 });
}

test.describe("Slack — OAuth connection (Tools → Slack)", () => {
  test("not connected: the card explains what connecting buys and offers Connect", async ({ launchApp }) => {
    const { window } = await launchApp();
    await openSlackPanel(window);

    const card = window.locator(".crm-oauth-card");
    await expect(card).toContainText("Slack · OAuth connection");
    await expect(card).toContainText("Not connected");
    await expect(card).toContainText("post messages and look up users");
    await expect(card.getByRole("button", { name: "Connect Slack" })).toBeEnabled();
  });

  test("connected: shows the TEAM name and who connected it, with Reconnect + Disconnect", async ({ launchApp }) => {
    const { window } = await launchApp(CONNECTED);
    await openSlackPanel(window);

    const card = window.locator(".crm-oauth-card");
    await expect(card).toContainText("Connected · Acme Slack");
    await expect(card).toContainText("connected by Morgan");
    await expect(card.getByRole("button", { name: "Reconnect" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Disconnect" })).toBeVisible();
    // Slack's OAuth grant IS the whole credential — unlike a CRM, there is no
    // separate API key beside it, so that note must NOT appear.
    await expect(card).not.toContainText("API key below is separate");
  });

  test("NOT CONFIGURED: Connect is disabled and says why, rather than dead-ending", async ({ launchApp }) => {
    // A self-hosted deployment with no SLACK_CLIENT_ID can never complete the
    // handshake. A live button here would open a broken consent screen.
    const { window } = await launchApp(UNCONFIGURED);
    await openSlackPanel(window);

    const card = window.locator(".crm-oauth-card");
    await expect(card).toContainText("isn't set up on this deployment yet");
    await expect(card.getByRole("button", { name: "Connect Slack" })).toBeDisabled();
  });

  test("Connect opens the SYSTEM BROWSER at a correct Slack authorize URL", async ({ launchApp }) => {
    const { window, app } = await launchApp();
    await openSlackPanel(window);

    // Capture the Electron main-process openExternal rather than launching a
    // real browser: the URL IS the assertion.
    const opened = app.evaluate(({ shell }) => {
      return new Promise<string>((resolve) => {
        const original = shell.openExternal.bind(shell);
        shell.openExternal = async (url: string) => {
          resolve(url);
          return undefined as unknown as void;
        };
        void original;
      });
    });

    await window.locator(".crm-oauth-card").getByRole("button", { name: "Connect Slack" }).click();

    const url = new URL(await opened);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    // The state is minted SERVER-side: an openExternal navigation carries no
    // gtmgrid.dev cookie, so a browser-minted state would dead-end on the web
    // route's session gate.
    expect(url.searchParams.get("state")).toBeTruthy();
    // Sent explicitly because Slack silently routes to the FIRST configured
    // redirect URL when the param is absent and several are registered.
    expect(url.searchParams.get("redirect_uri")).toContain("/api/oauth/slack/callback");
    expect(url.searchParams.get("scope")).toContain("chat:write");
  });

  test("Connect shows a waiting state and converges once the connection lands", async ({ launchApp }) => {
    const { window, app } = await launchApp();
    await openSlackPanel(window);

    // Swallow the browser hand-off so the app stays in its polling state.
    await app.evaluate(({ shell }) => {
      shell.openExternal = async () => undefined as unknown as void;
    });

    const card = window.locator(".crm-oauth-card");
    await card.getByRole("button", { name: "Connect Slack" }).click();
    // The poll — not the gtmgrid:// deep link — is the reliable completion
    // signal; the deep link is best-effort.
    await expect(card.getByRole("button", { name: /Waiting for Slack…/ })).toBeVisible();
  });

  test("disconnect requires confirmation, then flips to Not connected", async ({ launchApp }) => {
    const { window } = await launchApp(CONNECTED);
    await openSlackPanel(window);

    const card = window.locator(".crm-oauth-card");
    await card.getByRole("button", { name: "Disconnect" }).click();
    // Armed, not fired: still connected until confirmed.
    await expect(card).toContainText("Connected · Acme Slack");

    await card.getByRole("button", { name: "Confirm disconnect" }).click();
    await expect(card).toContainText("Not connected", { timeout: 15_000 });
    await expect(card.getByRole("button", { name: "Connect Slack" })).toBeVisible();
  });
});
