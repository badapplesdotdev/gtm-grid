/**
 * Renders every lifecycle template with realistic sample props (mirroring the
 * Claude Design mocks) to `preview/out/*.html` for eyeball + CI review.
 * Run: `pnpm -F @gtmgrid/email preview`
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OutboundEmail } from "../src/templates.js";
import { firstTableEmail } from "../src/lifecycle/first-table.js";
import { columnsAreFunctionsEmail } from "../src/lifecycle/columns-are-functions.js";
import { connectAiKeyEmail } from "../src/lifecycle/connect-ai-key.js";
import { inviteTeamEmail } from "../src/lifecycle/invite-team.js";
import { runFinishedEmail } from "../src/lifecycle/run-finished.js";
import { signalsWaitingEmail } from "../src/lifecycle/signals-waiting.js";
import { weeklyDigestEmail } from "../src/lifecycle/weekly-digest.js";
import { dormantEmail } from "../src/lifecycle/dormant.js";
import { trialWinbackEmail } from "../src/lifecycle/trial-winback.js";
import { paymentFailedEmail } from "../src/lifecycle/payment-failed.js";
import { creditWarningEmail } from "../src/lifecycle/credit-warning.js";
import { teammateJoinedEmail } from "../src/lifecycle/teammate-joined.js";
import { subscriptionConfirmedEmail } from "../src/lifecycle/subscription-confirmed.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "preview", "out");

const TO = "preview@gtmgrid.dev";
const URL = "https://gtmgrid.dev/preview";
const LINKS = {
  settingsUrl: "https://gtmgrid.dev/account/notifications",
  unsubscribeUrl: "https://gtmgrid.dev/email/unsubscribe?token=SAMPLE",
};

/** name → builder promise; sample data mirrors the design cards. */
const SAMPLES: Record<string, Promise<OutboundEmail>> = {
  "08-first-table": firstTableEmail({ to: TO, ctaUrl: URL, links: LINKS }),
  "09-columns-are-functions": columnsAreFunctionsEmail({
    to: TO,
    table: "Q3 Outbound",
    ctaUrl: URL,
    links: LINKS,
  }),
  "10-connect-ai-key": connectAiKeyEmail({ to: TO, ctaUrl: URL, links: LINKS }),
  "11-invite-team": inviteTeamEmail({
    to: TO,
    workspace: "Northbeam GTM",
    seatsOpen: 2,
    ctaUrl: URL,
    links: LINKS,
  }),
  "12-run-finished": runFinishedEmail({
    to: TO,
    doneCount: 214,
    errorCount: 3,
    table: "Q3 Outbound",
    fn: "trigify.enrichProfile",
    column: "Trigify profile",
    duration: "2m 14s",
    creditsUsed: 214,
    sampleRows: ["Dana Lin · Ramp", "Omar Reyes · Vercel"],
    viewUrl: URL,
    links: LINKS,
  }),
  "13-signals-waiting": signalsWaitingEmail({
    to: TO,
    n: 12,
    search: "VP Sales · hiring",
    hotCount: 3,
    signals: [
      { name: "Marcus Feld · Datadog", detail: "posted about scaling the SDR team", score: 92 },
      { name: "Elena Ruiz · Figma", detail: "new VP Sales — started this week", score: 88 },
      { name: "Tom Okafor · Airtable", detail: "hiring 4 AEs in EMEA", score: 81 },
    ],
    viewUrl: URL,
    links: LINKS,
  }),
  "14-weekly-digest": weeklyDigestEmail({
    to: TO,
    workspace: "Northbeam GTM",
    weekRange: "Jun 29 – Jul 5",
    stats: { rowsEnriched: 1240, runsCompleted: 18, creditsUsed: 1600, teammatesActive: 3 },
    deltas: { rowsEnriched: "▲ 18% vs last week", teammatesActive: "▲ 1 new this week" },
    topTables: [{ name: "Q3 Outbound", rowsAdded: 214 }],
    openUrl: URL,
    links: LINKS,
  }),
  "15-dormant": dormantEmail({
    to: TO,
    table: "Q3 Outbound",
    cellsChanged: 96,
    newRows: 12,
    columnsRecomputed: 4,
    rowsNeedRerun: 7,
    jumpUrl: URL,
    links: LINKS,
  }),
  "16-trial-winback": trialWinbackEmail({
    to: TO,
    tableCount: 3,
    rowsEnriched: 840,
    columnCount: 9,
    reactivateUrl: URL,
    links: LINKS,
  }),
  "17-payment-failed": paymentFailedEmail({
    to: TO,
    workspace: "Northbeam GTM",
    cardLast4: "4242",
    attempt: 0,
    updatePaymentUrl: URL,
    links: LINKS,
  }),
  "18-credit-warning": creditWarningEmail({
    to: TO,
    used: 8000,
    limit: 10000,
    percent: 80,
    resetsAt: "Aug 1",
    manageUrl: URL,
    links: LINKS,
  }),
  "19-teammate-joined": teammateJoinedEmail({
    to: TO,
    teammateName: "Sam Rivera",
    teammateEmail: "sam@northbeam.io",
    workspace: "Northbeam GTM",
    openWorkspaceUrl: URL,
    links: LINKS,
  }),
  "20-subscription-confirmed": subscriptionConfirmedEmail({
    to: TO,
    plan: "Team",
    workspace: "Northbeam GTM",
    seats: 3,
    amount: "$60.00",
    paymentMethod: "Visa •••• 4242",
    nextCharge: "Aug 4, 2026",
    invoiceId: "INV-2041",
    billingUrl: URL,
    links: LINKS,
  }),
};

await mkdir(OUT, { recursive: true });
for (const [name, emailPromise] of Object.entries(SAMPLES)) {
  const email = await emailPromise;
  // CID images don't resolve in a browser — swap in the repo asset for preview.
  const previewHtml = email.html.replaceAll(
    "cid:gg-icon-color",
    "../icon-color-preview.png",
  );
  await writeFile(join(OUT, `${name}.html`), previewHtml);
  await writeFile(join(OUT, `${name}.txt`), email.text);
  console.log(`rendered ${name} (subject: ${email.subject})`);
}
console.log(`\n${Object.keys(SAMPLES).length} template(s) → ${OUT}`);
