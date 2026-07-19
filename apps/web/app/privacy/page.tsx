import type { Metadata } from "next";
import Link from "next/link";
import { CookieSettingsButton } from "../CookieConsent";

export const metadata: Metadata = {
  title: "Privacy Policy — GTM Grid",
  description: "What data GTM Grid collects, why we collect it, and the choices you have.",
};

const LAST_UPDATED = "19 July 2026";

// Plain-language privacy policy grounded in what the code actually does:
// account fields from packages/db/src/schema.ts (users/sessions/accounts),
// envelope-encrypted credentials, cloud-stored grid data, local execution,
// and the third parties that actually RECEIVE data, which is what §5 must list:
// Supabase/Postgres, Vercel, Autumn+Stripe, Resend, PostHog, Inngest, PartyKit.
// Better Auth is deliberately absent — it is a self-hosted library running inside
// apps/web, not a processor, so it must not be added to §5.
//
// Business facts (entity, address, retention, supervisory authority) supplied by
// the business owner, not derived from code — re-check them if the company
// details change. NOT bespoke legal advice; have counsel review before relying
// on it in a dispute.
export default function PrivacyPage() {
  return (
    <main className="container prose">
      <Link className="wordmark prose__home" href="/">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="wordmark__mark" src="/brand/icon.png" alt="" width={16} height={16} aria-hidden="true" />
        GTM Grid
      </Link>

      <header className="prose__head">
        <span className="eyebrow">legal</span>
        <h1>Privacy Policy</h1>
        <p className="prose__lede">Last updated: {LAST_UPDATED}</p>
      </header>

      <p>
        This policy explains what personal data GTM Grid (&ldquo;we&rdquo;, &ldquo;us&rdquo;)
        collects when you use the GTM Grid desktop application, website, and cloud services
        (together, the &ldquo;Service&rdquo;), why we collect it, who we share it with, and the
        choices you have. It sits alongside our <Link href="/terms">Terms of Service</Link>.
      </p>

      <h2>1. Who we are</h2>
      <p>
        The Service is operated by Aphex Automate LTD, 86 Broadway, Cowbridge, CF64 1TR,
        United Kingdom. For data you put into a workspace about your own prospects and
        customers, you are the data controller and we act as your processor. For your
        account and billing data, we are the controller. Privacy questions:{" "}
        <a href="mailto:morgan@trigify.io">morgan@trigify.io</a>.
      </p>

      <h2>2. Data we collect</h2>
      <h3>Account data</h3>
      <ul>
        <li>Your name, email address, and whether that email has been verified.</li>
        <li>An avatar image, if you set one or your identity provider supplies one.</li>
        <li>
          Sign-in records: a record of each active sign-in session, including the IP address
          and browser user-agent captured at sign-in, which we keep for security and audit
          purposes. If you sign in with a third-party provider we also store that
          provider&rsquo;s account identifier and tokens.
        </li>
        <li>
          A last-active timestamp, and your email preferences, so we can send lifecycle mail
          you have not opted out of.
        </li>
      </ul>

      <h3>Workspace and collaboration data</h3>
      <p>
        Workspace names, membership and roles, and invitations you send (including the invitee&rsquo;s
        email address). Realtime collaboration broadcasts presence — who is viewing a grid — to
        other members of that workspace while you are connected.
      </p>

      <h3>Customer Data in your grids</h3>
      <p>
        Grid content — tables, columns, rows, and cells — is stored in our cloud database. This
        frequently contains personal data about third parties (for example prospect names, job
        titles, company details, and email addresses) that you import, sync from a connected CRM,
        or generate with a column. We process it on your instruction to operate the Service; we do
        not sell it, and we do not use it to train AI models.
      </p>

      <h3>Credentials</h3>
      <p>
        API keys and connector credentials you supply are envelope-encrypted before they are
        written to the database and are never stored in plaintext. They are decrypted only to run
        the feature you invoked.
      </p>

      <h3>Usage and diagnostic data</h3>
      <p>
        Product analytics events (features used, coarse device, app version and browser
        information, approximate location derived from IP) and operational logs. We use these
        to understand how the product is used and to keep it working.
      </p>
      <p>
        When the app hits an error we capture an automatic error report containing the error
        message, stack trace, and the app state around the failure. Error messages can
        incidentally include fragments of the data being processed at the time. We use these
        reports only to diagnose and fix faults.
      </p>
      <p>
        <strong>We do not record your screen or your sessions.</strong> Session replay is
        disabled in our analytics across both the desktop app and this website, so the
        contents of your grids are never captured to video or DOM recordings. If we ever
        turn it on we will update this policy and tell you before it takes effect.
      </p>

      <h3>Billing data</h3>
      <p>
        Plan, seat count, and metered usage. Card details go directly to our payment processor —
        we never see or store full card numbers.
      </p>

      <h2>3. What stays on your machine</h2>
      <p>
        By default, column execution runs locally in the desktop app rather than on our servers.
        Where you bring your
        own AI provider key, prompts and row content are sent from your machine directly to that
        provider; we do not receive or retain that traffic. Local-only projects are stored on your
        device and their contents are not uploaded to us. The one exception is error reporting:
        if a run fails, the desktop app and its local engine send us an error report as
        described above, which can contain fragments of the data being processed.
      </p>
      <p>
        The exceptions are server-side runs you explicitly choose — pipelines you set to run on
        the cloud target, scheduled syncs, and inbound webhook auto-enrichment. These execute in
        our cloud worker and therefore do pass through our infrastructure, including the row
        content they process. Cloud runs use workspace-shared credentials only; they never use a
        member&rsquo;s personal keys or the local coding-agent fallback.
      </p>

      <h2>4. Why we process it, and on what basis</h2>
      <ul>
        <li>
          <strong>To provide the Service</strong> — hosting your workspaces, authenticating you,
          syncing and enriching your data. Basis: performance of our contract with you.
        </li>
        <li>
          <strong>To bill you</strong> — subscriptions, seats, and usage metering. Basis: contract
          and legal obligation.
        </li>
        <li>
          <strong>To keep the Service secure and reliable</strong> — abuse prevention, debugging,
          capacity planning. Basis: our legitimate interests.
        </li>
        <li>
          <strong>To improve the product and send lifecycle email</strong> — analytics and
          onboarding or digest mail. Basis: on this website, your consent, collected via the
          cookie banner before anything is stored on your device. In the desktop app we currently
          rely on legitimate interests: it records product analytics to local storage on launch
          and does not yet offer an in-app opt-out. We are adding one; until then, email us and
          we will exclude you. Lifecycle email relies on legitimate interests, and you can opt out
          of non-transactional email at any time.
        </li>
      </ul>

      <h2>5. Who we share it with</h2>
      <p>
        We do not sell personal data. We share it with service providers who process it on our
        behalf under contract:
      </p>
      <ul>
        <li><strong>Supabase</strong> — the Postgres database that stores workspace and grid data.</li>
        <li><strong>Vercel</strong> — hosting for the website and API.</li>
        <li><strong>Stripe</strong> (via Autumn) — payment processing and subscription billing.</li>
        <li><strong>Resend</strong> — transactional and lifecycle email delivery.</li>
        <li><strong>PostHog</strong> — product analytics and error reporting.</li>
        <li>
          <strong>Inngest</strong> — durable background job processing. Inbound webhook
          records and cloud pipeline runs pass through Inngest as event payloads, so it
          receives Customer Data, not only job metadata.
        </li>
        <li><strong>PartyKit</strong> — realtime presence.</li>
      </ul>
      <p>
        Connectors you choose to enable (your CRM, data providers, AI model providers)
        receive the data needed to fulfil the request you made — their own privacy policies govern
        that processing. We may disclose data where the law requires it — and we will notify
        you when we are legally permitted to do so, which court orders and similar requests
        sometimes forbid. If we are ever part of a merger or acquisition we will tell you
        before your data moves.
      </p>

      <h2>6. International transfers</h2>
      <p>
        Our providers may process data in the United States and elsewhere. Where data leaves the
        UK or EEA we rely on appropriate safeguards, including the UK Addendum and EU Standard
        Contractual Clauses in our agreements with those providers.
      </p>

      <h2>7. How long we keep it</h2>
      <ul>
        <li>
          <strong>Account, workspace, and grid data:</strong> we do not apply an automatic
          expiry — this data is kept for as long as you want it, and is deleted when you ask
          us to delete it. You can request deletion at any time using the contact address
          below, and we will action it unless we are legally required to keep a record.
        </li>
        <li>
          <strong>Operational logs:</strong> held by our hosting provider, Vercel, and kept
          only for the short period their platform retains them, for fault diagnosis.
        </li>
        <li>
          <strong>Analytics and error reports:</strong> held by PostHog under their retention
          schedule for our plan.
        </li>
        <li>
          <strong>Pipeline run data:</strong> execution history for pipeline runs is retained
          for 30 days, after which completed runs are deleted automatically. Results a
          pipeline writes into your grid cells are your data, not execution logs, and are
          kept until you overwrite or delete them.
        </li>
        <li>
          <strong>Billing records:</strong> retained as long as tax and accounting law
          requires.
        </li>
      </ul>

      <h2>8. Security</h2>
      <p>
        Data is encrypted in transit and at rest. Connector secrets are additionally
        envelope-encrypted at the application layer. Access to production data is limited to
        people who need it. Inbound webhooks are authenticated with an HMAC signature. No system
        is perfectly secure, but we work to keep the risk low and will notify you of a breach
        affecting your data as the law requires.
      </p>

      <h2>9. Your rights</h2>
      <p>
        Depending on where you live, you may have the right to access, correct, delete, export, or
        restrict processing of your personal data, to object to processing based on legitimate
        interests, and to withdraw consent. Much of this you can do yourself in the app; for
        anything else, email <a href="mailto:morgan@trigify.io">morgan@trigify.io</a> and we will
        respond within one month.
      </p>
      <p>
        If you are unhappy with how we have handled your data you can complain to your local data
        protection authority. In the UK that is the Information Commissioner&rsquo;s Office
        (<a href="https://ico.org.uk">ico.org.uk</a>).
      </p>
      <p>
        If your data is in a customer&rsquo;s workspace and you are not a GTM Grid user, that
        customer is the controller — contact them directly, or contact us and we will pass the
        request on.
      </p>

      <h2>10. Cookies</h2>
      <p>
        We use cookies that are strictly necessary to keep you signed in and to remember your
        cookie choice. These do not need your consent because the site cannot work without them.
      </p>
      <p>
        We would also like to use analytics cookies to understand how the product is used. We
        ask first: until you accept, our analytics tool runs with in-memory storage only and
        writes nothing to your device. If you decline, it stays that way. We do not use
        advertising cookies, and we do not record your screen.
      </p>
      <p>
        You can change your mind at any time — <CookieSettingsButton /> re-opens the banner.
        Declining opts you out, clears the identifiers our analytics tool was holding, and stops
        anything further being written to your device.
      </p>
      <p>
        This section describes this website. The desktop application is not a browser and does
        not use cookies, but it does write analytics identifiers to local storage on your machine
        when it launches — see section 4 for the basis we rely on there and how to opt out.
      </p>

      <h2>11. Children</h2>
      <p>
        The Service is a business tool and is not directed at anyone under 16. We do not knowingly
        collect their data; if we learn we have, we will delete it.
      </p>

      <h2>12. Self-hosting</h2>
      <p>
        GTM Grid is source-available and can be self-hosted. If you run your own instance, your
        data stays in your infrastructure and this policy does not apply to it — you become the
        controller for everything in that deployment.
      </p>

      <h2>13. Changes to this policy</h2>
      <p>
        We may update this policy. If a change is material we will notify you (for example by
        email or in the app) before it takes effect, and we will always move the &ldquo;last
        updated&rdquo; date above.
      </p>

      <h2>14. Contact</h2>
      <p>
        Questions about this policy or your data:{" "}
        <a href="mailto:morgan@trigify.io">morgan@trigify.io</a>.
      </p>
    </main>
  );
}
