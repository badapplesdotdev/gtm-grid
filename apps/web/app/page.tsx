import "./_home/site.css";
import { getLatestRelease } from "@/lib/releases";
import { Nav } from "./_home/Nav";
import { Faq } from "./_home/Faq";
import { Pricing } from "./_home/Pricing";
import { QuickStart } from "./_home/QuickStart";
import { Reveal } from "./_home/Reveal";
import {
  AgentPanel,
  ConnectorsWall,
  FinalCTA,
  Footer,
  Hero,
  HowItWorks,
  LocalCloud,
  Marquee,
  PricingNotes,
  Surfaces,
} from "./_home/sections";

// Marketing homepage — "Grid, the headless GTM engine" (the Claude Design
// handoff, gtm-grid/Website.html). Server-rendered: every section is real JSX in
// the SSR HTML, with only the interactive pieces (Nav scroll, hero animation,
// quick-start tabs, pricing toggle, FAQ, scroll-reveal) as client components.
// Design styles are scoped under `.gtm-home` (see _home/site.css) so they can't
// leak into /invite or /download. The release version comes from the live GitHub
// release; revalidate hourly so a new release surfaces without a redeploy.
export const revalidate = 3600;

const FALLBACK_VERSION = "0.21.0";

export default async function Home() {
  const release = await getLatestRelease();
  const version = release?.version ?? FALLBACK_VERSION;

  return (
    <div className="gtm-home" data-theme="light">
      <div className="page">
        <Nav />
        <a id="top" />
        <Hero version={version} />
        <Marquee />
        <Surfaces />
        <HowItWorks />
        <ConnectorsWall />
        <AgentPanel />

        <section className="band" id="quickstart">
          <div className="wrap">
            <div className="qs-head">
              <h2><span className="qs-chev">&rsaquo;</span>Quick start</h2>
            </div>
            <QuickStart />
            <p className="qs-caption">
              Signed desktop builds for macOS, Windows, and Linux — or run it from source. The CLI and MCP server run anywhere Node does. <a href="/download">All platforms &amp; versions →</a>
            </p>
          </div>
        </section>

        <LocalCloud />

        <section className="band" id="pricing">
          <div className="wrap">
            <div className="sec-head center">
              <span className="eyebrow"><span className="dot" />Cloud pricing</span>
              <h2>Self-host free. <span className="accent">Cloud is metered.</span></h2>
              <p>Self-host on your own Postgres for free. Cloud plans are billed per seat and metered by <b>cloud actions</b> — runs that happen on our infrastructure instead of your machine. No row, table, or connector caps, ever.</p>
            </div>
            <div className="local-strip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></svg>
              <span className="ls-tx"><b>Self-host — $0, source-available, unlimited.</b> Cloud only covers runs on our infrastructure.</span>
              <a href="/download">Download free <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></a>
            </div>
            <Pricing />
            <PricingNotes />
          </div>
        </section>

        <section className="band">
          <div className="wrap">
            <div className="sec-head">
              <span className="eyebrow"><span className="dot" />FAQ</span>
              <h2>The honest answers.</h2>
            </div>
            <Faq />
          </div>
        </section>

        <FinalCTA />
        <Footer version={version} />
      </div>
      <Reveal />
    </div>
  );
}
