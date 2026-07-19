import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "../_legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service — GTM Grid",
  description: "The terms that govern your use of the GTM Grid desktop app and cloud services.",
};

const LAST_UPDATED = "19 July 2026";

// Plain-language boilerplate ToS covering the product as it actually works:
// desktop app + cloud workspaces, BYO AI keys, read-only CRM connections,
// trials/subscriptions, source-available license. NOT bespoke legal advice —
// review with counsel before relying on it in a dispute.
export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated={LAST_UPDATED}>
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your use of the GTM Grid desktop
        application, website, and cloud services (together, the &ldquo;Service&rdquo;), operated
        by Aphex Automate LTD, 86 Broadway, Cowbridge, CF64 1TR, United Kingdom
        (&ldquo;we&rdquo;, &ldquo;us&rdquo;) — the same entity identified as data controller in
        our <Link href="/privacy">Privacy Policy</Link>. By creating an account or using the
        Service you agree to these Terms. If you are using the Service on behalf of a company,
        you represent that you have authority to bind that company, and &ldquo;you&rdquo; means
        that company.
      </p>

      <h2>1. The Service</h2>
      <p>
        GTM Grid is a go-to-market data workspace: a desktop application backed by cloud
        workspaces where teams import, sync, and enrich business data using connectors and
        AI-powered columns. Parts of the product run locally on your machine; workspace data,
        collaboration, and scheduled syncs run in our cloud.
      </p>

      <h2>2. Accounts</h2>
      <p>
        You must provide accurate information when creating an account and keep your credentials
        secure. You are responsible for all activity under your account. Workspace owners and
        members you invite can access data in that workspace — invite people you trust.
      </p>

      <h2>3. Subscriptions, trials, and billing</h2>
      <ul>
        <li>New workspaces may include a free trial. When a trial ends, paid features lock until you subscribe.</li>
        <li>Paid plans bill in advance on a recurring basis via our payment processor and renew automatically until cancelled.</li>
        <li>Some features are metered (for example, cloud actions). Plan limits are shown in the app and on our pricing page.</li>
        <li>You can cancel at any time; access continues until the end of the paid period. Except where required by law, payments are non-refundable.</li>
      </ul>

      <h2>4. Your data</h2>
      <ul>
        <li>
          <strong>You own your data.</strong> Content you import, sync, or create in a workspace
          (&ldquo;Customer Data&rdquo;) remains yours. You grant us the limited rights needed to
          host, process, back up, and display it — solely to operate the Service.
        </li>
        <li>
          You are responsible for having the necessary rights to the data you bring into the
          Service, including personal data about your prospects and customers, and for using it
          in compliance with applicable law (including data-protection and anti-spam laws).
        </li>
        <li>We may delete Customer Data a reasonable period after account closure or workspace deletion.</li>
      </ul>

      <h2>5. Third-party services and connectors</h2>
      <ul>
        <li>
          The Service connects to third-party products you choose — for example CRMs (such as
          Attio), data providers, and AI model providers. Your use of those products is governed
          by their own terms, and you authorize us to access them on your behalf using the
          credentials or grants you provide.
        </li>
        <li>
          CRM connections are <strong>read-only</strong>: the Service does not write to, update,
          or delete records in your connected CRM.
        </li>
        <li>
          Where you bring your own API keys (for example, AI provider keys), you are responsible
          for those accounts and their charges. Keys are stored encrypted and used only to run
          the features you invoke.
        </li>
        <li>We are not responsible for third-party services, their availability, or their data practices.</li>
      </ul>

      <h2>6. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>break the law, infringe others&rsquo; rights, or send spam with data processed through the Service;</li>
        <li>probe, breach, or overload the Service, or access another customer&rsquo;s workspace or data;</li>
        <li>resell or provide the Service to third parties as your own hosted offering, except as the source license permits;</li>
        <li>use the Service to build a directly competing product by systematically extracting our software or non-public interfaces.</li>
      </ul>

      <h2>7. Software and intellectual property</h2>
      <p>
        The Service, including the desktop application and all software, is our intellectual
        property or that of our licensors. Public source code we publish is licensed under the
        license stated in the repository (FSL-1.1-MIT); these Terms govern the hosted Service
        and official builds. We may update the software automatically to keep you secure and
        current.
      </p>

      <h2>8. AI features</h2>
      <p>
        AI-generated output can be inaccurate. You are responsible for reviewing output before
        relying on it or sending it to anyone. Where AI features use your own provider keys,
        the provider&rsquo;s terms apply to that processing.
      </p>

      <h2>9. Availability and changes</h2>
      <p>
        We work hard to keep the Service available but do not guarantee uninterrupted operation.
        We may change, suspend, or discontinue features, and will make reasonable efforts to
        notify you of material changes that affect you.
      </p>

      <h2>10. Disclaimers</h2>
      <p>
        THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT
        WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING FITNESS FOR A PARTICULAR PURPOSE,
        MERCHANTABILITY, AND NON-INFRINGEMENT.
      </p>

      <h2>11. Limitation of liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL,
        SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE, OR DATA. OUR
        TOTAL LIABILITY ARISING OUT OF THE SERVICE IS LIMITED TO THE AMOUNTS YOU PAID US IN THE
        TWELVE MONTHS BEFORE THE CLAIM. NOTHING IN THESE TERMS EXCLUDES LIABILITY THAT CANNOT BE
        EXCLUDED BY LAW.
      </p>

      <h2>12. Termination</h2>
      <p>
        You may stop using the Service and delete your workspace at any time. We may suspend or
        terminate access for material breach of these Terms, and where practical we will warn
        you first. Sections that by their nature should survive (including 4, 7, 10, 11) survive
        termination.
      </p>

      <h2>13. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. If a change is material we will notify you
        (for example by email or in the app) before it takes effect. Continuing to use the
        Service after a change takes effect means you accept the updated Terms.
      </p>

      <h2>14. Contact</h2>
      <p>
        Questions about these Terms: <a href="mailto:legal@gtmgrid.dev">legal@gtmgrid.dev</a>.
      </p>
    </LegalPage>
  );
}
