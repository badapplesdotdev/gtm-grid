import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Attio integration — GTM Grid docs",
  description:
    "Pull Attio People, Companies, Deals, or any list into a live GTM Grid table — read-only, synced daily, with AI enrichment layered on top.",
};

// Static docs page (no data fetches). Linked from the Attio App Store listing,
// the marketing footer, and support replies — written for a non-technical
// operator, mirroring the in-app wizard's language.
export default function AttioDocsPage() {
  return (
    <main className="container prose">
      <Link className="wordmark prose__home" href="/">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="wordmark__mark" src="/brand/icon.png" alt="" width={16} height={16} aria-hidden="true" />
        GTM Grid
      </Link>

      <header className="prose__head">
        <span className="eyebrow">docs · integrations</span>
        <h1>Attio integration</h1>
        <p className="prose__lede">
          Pull your Attio People, Companies, Deals — or any saved list — into a live GTM Grid
          table, then enrich every row with AI. Read-only by design: GTM Grid never writes to
          your CRM.
        </p>
        <Link className="btn btn--primary prose__cta" href="/download">
          Download GTM Grid
        </Link>
      </header>

      <h2>What it does</h2>
      <p>
        A synced table mirrors an Attio source into your grid. Records pull in as rows, the
        attributes you choose become columns, and the table refreshes automatically every day
        (plus a manual <strong>Sync now</strong> whenever you want it). Everything you build on
        top — AI enrichment columns, research columns, notes — belongs to the grid and survives
        every re-sync.
      </p>

      <h2>Connecting Attio</h2>
      <ol>
        <li>
          <Link href="/download">Download GTM Grid</Link> and sign in. GTM Grid is a desktop
          app for macOS, Windows, and Linux.
        </li>
        <li>In GTM Grid, open <strong>New table → From your CRM</strong> and pick Attio.</li>
        <li>
          Your browser opens Attio&rsquo;s consent screen. GTM Grid requests{" "}
          <strong>read-only</strong> access: records, object and list configuration, and
          workspace members (so &ldquo;Owner&rdquo; columns can show names). No write or delete
          permissions are ever requested.
        </li>
        <li>Approve, and you&rsquo;re bounced straight back into the app.</li>
      </ol>
      <p>
        The connection is <strong>workspace-wide</strong>: one teammate connects once, and
        everyone in your GTM Grid workspace can create synced tables from it. The person
        connecting needs permission to authorize apps in your Attio workspace.
      </p>

      <h2>Creating a synced table</h2>
      <ul>
        <li>
          <strong>Choose a source</strong> — any object (People, Companies, Deals, custom
          objects) or any list. Lists are ideal for narrowing big objects to the records that
          matter.
        </li>
        <li>
          <strong>Map fields to columns</strong> — recommended fields are pre-selected, with
          live sample values so you can see exactly what each column will hold.
        </li>
        <li>
          <strong>Add filters</strong> (optional) — six operators (is, is not, contains, is
          known, is unknown, after) so only matching records sync.
        </li>
        <li>
          <strong>Pick duplicate handling</strong>:
          <ul>
            <li>
              <em>Update existing</em> — match records to rows on a key (like email or domain)
              and refresh changed fields. This is the default and what most teams want.
            </li>
            <li><em>Skip existing</em> — only add records the grid hasn&rsquo;t seen.</li>
            <li>
              <em>Always create</em> — import every record as a new row. These tables sync on
              demand only (a daily re-import would duplicate your data).
            </li>
          </ul>
        </li>
      </ul>

      <h2>How syncing behaves</h2>
      <ul>
        <li>Synced tables refresh <strong>daily at 09:00 UTC</strong>, plus manual Sync now.</li>
        <li>
          Columns synced from Attio are <strong>read-only</strong> in the grid — they always
          reflect your CRM. Columns you add are fully editable and enrichable.
        </li>
        <li>
          Records deleted in Attio (or that stop matching your filters) are{" "}
          <strong>never deleted</strong> from the grid — their rows are flagged as no longer in
          Attio, and all your enrichment work is preserved.
        </li>
        <li>
          Each table has a <strong>sync log</strong> showing what every run did — records
          added, updated, skipped, or flagged — in plain English, with one-click retry.
        </li>
        <li>
          Synced tables hold up to <strong>10,000 records</strong> on the Team plan and{" "}
          <strong>50,000</strong> on larger plans. Use lists or filters to narrow bigger
          objects.
        </li>
      </ul>

      <h2>Security &amp; data</h2>
      <ul>
        <li>
          The connection is <strong>strictly read-only</strong> — GTM Grid cannot write to,
          update, or delete anything in Attio.
        </li>
        <li>
          Access tokens are encrypted at rest and scoped to your workspace. Disconnecting (from
          Attio&rsquo;s settings, or by removing the credential in GTM Grid) stops all syncing
          immediately.
        </li>
        <li>Synced data lives in your GTM Grid workspace and is never shared across tenants.</li>
      </ul>

      <h2>Troubleshooting</h2>
      <ul>
        <li>
          <strong>&ldquo;Reconnect Attio to resume syncing&rdquo;</strong> — the connection was
          revoked or expired. Click Reconnect on the table&rsquo;s banner and re-approve; syncing
          resumes automatically.
        </li>
        <li>
          <strong>&ldquo;N fields could not be mapped&rdquo;</strong> — an attribute was deleted
          or renamed in Attio. Everything else keeps syncing; recreate the sync to pick up the
          new schema.
        </li>
        <li>
          <strong>A source no longer exists</strong> — if an object or list is deleted in Attio,
          the table pauses with a clear message. Your rows stay; pick a new source or remove the
          sync.
        </li>
      </ul>

      <p className="prose__foot">
        Questions? Email <a href="mailto:support@gtmgrid.dev">support@gtmgrid.dev</a> — we read
        everything.
      </p>
    </main>
  );
}
