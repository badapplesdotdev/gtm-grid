"use client";

// Cloud pricing — monthly/annual toggle over the REAL plan catalog
// (packages/cloud/src/plans.ts): Free is local-only, Team $20, Business $40,
// Unlimited $99 per seat/mo; annual is 2 months free ($200/$400/$990 a year).
// Overage rates ($0.50 / $0.40 / none) are taken verbatim from plans.ts.
//
// IMPORTANT correction vs. the design mock: on the Free tier the cloud layer is
// LOCKED (EntitlementService.requireCloudAccess) — Free gets the unlimited local
// desktop app, NOT a cloud-actions allowance. Cloud actions start at Team.

import { useState } from "react";

type Billing = "monthly" | "annual";

function Tick() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function CloudIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19a4.5 4.5 0 0 0 .9-8.91 6 6 0 0 0-11.64-1.6A4 4 0 0 0 6 19Z" />
    </svg>
  );
}
function LaptopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M2 20h20" />
    </svg>
  );
}
function InfinityIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18.18 8A10 10 0 1 0 12 22" />
      <path d="M12 2v4M4.93 4.93l2.83 2.83" />
    </svg>
  );
}

interface PaidPlan {
  readonly name: string;
  readonly tagline: string;
  readonly monthly: number;
  readonly annualMonthly: number; // per-seat/mo when billed annually
  readonly annualYear: number; // per-seat/yr
  readonly meter: string;
  readonly meterIcon: "cloud" | "infinity";
  readonly over: string;
  readonly cta: string;
  readonly featured?: boolean;
  readonly badge?: string;
  readonly features: readonly { readonly text: string; readonly strong?: boolean }[];
}

const PAID: readonly PaidPlan[] = [
  {
    name: "Team",
    tagline: "Shared cloud grids for small teams.",
    monthly: 20,
    annualMonthly: 17,
    annualYear: 200,
    meter: "50,000 cloud actions / mo",
    meterIcon: "cloud",
    over: "then $0.50 / 1,000",
    cta: "Start 7-day trial",
    features: [
      { text: "Everything in Free, in the cloud", strong: true },
      { text: "Cloud sync & realtime multiplayer" },
      { text: "Shared workspace credentials" },
      { text: "Webhooks & scheduled runs" },
    ],
  },
  {
    name: "Business",
    tagline: "5× the headroom, lower overage.",
    monthly: 40,
    annualMonthly: 33,
    annualYear: 400,
    meter: "250,000 cloud actions / mo",
    meterIcon: "cloud",
    over: "then $0.40 / 1,000",
    cta: "Start 7-day trial",
    featured: true,
    badge: "Recommended",
    features: [
      { text: "Everything in Team", strong: true },
      { text: "5× the included cloud actions" },
      { text: "Lower overage — $0.40 / 1k vs $0.50" },
      { text: "Shared workspace credentials" },
    ],
  },
  {
    name: "Unlimited",
    tagline: "No metering. No overage. Ever.",
    monthly: 99,
    annualMonthly: 83,
    annualYear: 990,
    meter: "Unlimited cloud actions",
    meterIcon: "infinity",
    over: "no overage, no caps",
    cta: "Start 7-day trial",
    features: [
      { text: "Everything in Business", strong: true },
      { text: "Unlimited cloud actions — no metering" },
      { text: "No overage charges, ever" },
      { text: "Realtime multiplayer + shared credentials" },
    ],
  },
];

export function Pricing() {
  const [billing, setBilling] = useState<Billing>("monthly");
  const annual = billing === "annual";

  return (
    <>
      <div className="bill-toggle" role="tablist" aria-label="Billing period">
        <button
          type="button"
          className={`bill-opt${!annual ? " is-active" : ""}`}
          role="tab"
          aria-selected={!annual}
          onClick={() => setBilling("monthly")}
        >
          Monthly
        </button>
        <button
          type="button"
          className={`bill-opt${annual ? " is-active" : ""}`}
          role="tab"
          aria-selected={annual}
          onClick={() => setBilling("annual")}
        >
          Annual <span className="bill-save">2 months free</span>
        </button>
      </div>

      <div className="pricing">
        {/* Free — the local desktop tier (cloud locks on Free). */}
        <div className="price-card">
          <div className="price-head">
            <span className="plan-name">Free</span>
            <p className="plan-tagline">Local &amp; solo, forever.</p>
          </div>
          <div className="price-tag">
            <span className="price-amt">$0</span>
            <span className="price-per">/ forever</span>
          </div>
          <p className="price-bill">No account, no card</p>
          <div className="price-quota">
            <div className="price-meter">
              <LaptopIcon />
              <span><b>Runs 100% on your machine</b></span>
            </div>
            <p className="price-over"><b>Cloud actions</b> — paid plans only</p>
          </div>
          <a className="btn btn-outline" href="/download">Start free</a>
          <ul className="price-list">
            <li><Tick /> <span className="li-strong">The full source-available desktop app</span></li>
            <li><Tick /> Unlimited rows, tables &amp; functions</li>
            <li><Tick /> Every connector — bring your own keys</li>
            <li><Tick /> Local-only — cloud needs a paid plan</li>
          </ul>
        </div>

        {/* Paid cloud tiers. */}
        {PAID.map((p) => (
          <div className={`price-card${p.featured ? " featured" : ""}`} key={p.name}>
            {p.badge ? <span className="plan-badge">{p.badge}</span> : null}
            <div className="price-head">
              <span className="plan-name">{p.name}</span>
              <p className="plan-tagline">{p.tagline}</p>
            </div>
            <div className="price-tag">
              <span className="price-amt">${annual ? p.annualMonthly : p.monthly}</span>
              <span className="price-per">/ seat / mo</span>
            </div>
            <p className="price-bill">{annual ? `$${p.annualYear} / seat / yr` : "Billed monthly"}</p>
            <div className="price-quota">
              <div className="price-meter">
                {p.meterIcon === "cloud" ? <CloudIcon /> : <InfinityIcon />}
                <span>{p.meter}</span>
              </div>
              <p className="price-over"><b>Overage</b> — {p.over}</p>
            </div>
            <a className={`btn ${p.featured ? "btn-primary" : "btn-outline"}`} href="/download">{p.cta}</a>
            <ul className="price-list">
              {p.features.map((f) => (
                <li key={f.text}>
                  <Tick /> {f.strong ? <span className="li-strong">{f.text}</span> : f.text}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
