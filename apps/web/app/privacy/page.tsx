import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — GTM Grid",
  description: "What data GTM Grid collects, why we collect it, and the choices you have.",
};

const LAST_UPDATED = "19 July 2026";

// Plain-language privacy policy grounded in what the code actually does:
// account fields from packages/db/src/schema.ts (users/sessions/accounts),
// envelope-encrypted credentials, cloud-stored grid data, local execution,
// and the processors we actually depend on (Supabase/Postgres, Vercel,
// Better Auth, Autumn+Stripe, Resend, PostHog, Inngest, PartyKit).
//
// NOT bespoke legal advice. Four items marked [[ ]] below are facts about the
// business that cannot be read out of the codebase — legal entity, address,
// retention windows, and supervisory authority. Fill those in and have counsel
// review before this is relied on.
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
        choices you have. It sits alongside our <a href="/terms">Terms of Service</a>.
      </p>

      <h2>1. Who we are</h2>
      <p>
        The Service is operated by [[LEGAL ENTITY NAME]], [[REGISTERED ADDRESS]]. For data
        you put into a workspace about your own prospects and customers, you are the data
        controller and we act as your processor. For your account and billing data, we are
        the controller. Privacy questions:{" "}
        <a href="mailto:morgan@trigify.io">morgan@trigify.io</a>.
      </p>

      <h2>2. Data we collect</h2>
      <h3>Account data</h3>
      <ul>
        <li>Your name, email address, and whether that email has been verified.</li>
        <li>An avatar image, if you set one or your identity provider supplies one.</li>
        <li>
          Sign-in records: one session per signed-in device, and — if you sign in with a
          third-party provider — the provider&rsquo;s account identifier and tokens.
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
        Product analytics events (pages and features used, coarse device and browser information,
        approximate location derived from IP) and operational logs. We use these to understand how
        the product is used and to keep it working.
      </p>

      <h3>Billing data</h3>
      <p>
        Plan, seat count, and metered usage. Card details go directly to our payment processor —
        we never see or store full card numbers.
      </p>

      <h2>3. What stays on your machine</h2>
      <p>
        Column execution runs locally in the desktop app, not on our servers. Where you bring your
        own AI provider key, prompts and row content are sent from your machine directly to that
        provider; we do not receive or retain that traffic. Local-only projects are stored on your
        device and are not uploaded to us at all.
      </p>
      <p>
        The exceptions are server-side runs you explicitly enable — scheduled syncs and inbound
        webhook auto-enrichment — which execute in our cloud worker and therefore do pass through
        our infrastructure.
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
          onboarding or digest mail. Basis: legitimate interests, and consent where required. You
          can opt out of non-transactional email at any time.
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
        <li><strong>PostHog</strong> — product analytics.</li>
      </ul>
      <p>
        We also use Inngest for background job processing and PartyKit for realtime presence.
        Separately, connectors you choose to enable (your CRM, data providers, AI model providers)
        receive the data needed to fulfil the request you made — their own privacy policies govern
        that processing. We may disclose data if legally required, or as part of a merger or
        acquisition, in which case we will tell you first.
      </p>

      <h2>6. International transfers</h2>
      <p>
        Our providers may process data in the United States and elsewhere. Where data leaves the
        UK or EEA we rely on appropriate safeguards, including the UK Addendum and EU Standard
        Contractual Clauses in our agreements with those providers.
      </p>

      <h2>7. How long we keep it</h2>
      <ul>
        <li>Account and workspace data: for as long as your account is open.</li>
        <li>
          After you delete a workspace or close your account: deleted within
          [[RETENTION WINDOW — e.g. 30 days]], except where we must keep records longer.
        </li>
        <li>Billing records: retained as long as tax and accounting law requires.</li>
        <li>Analytics and logs: [[LOG RETENTION WINDOW]].</li>
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
        protection authority — in the UK, [[SUPERVISORY AUTHORITY — e.g. the Information
        Commissioner&rsquo;s Office]].
      </p>
      <p>
        If your data is in a customer&rsquo;s workspace and you are not a GTM Grid user, that
        customer is the controller — contact them directly, or contact us and we will pass the
        request on.
      </p>

      <h2>10. Cookies</h2>
      <p>
        We use cookies that are strictly necessary to keep you signed in, and analytics cookies to
        understand product usage. We do not use advertising cookies.
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
