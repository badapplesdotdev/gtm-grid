"use client";

// Sticky top nav with a scroll-triggered hairline (the design's `.nav.scrolled`).
// The GitHub button shows the real star count when we could resolve it, else a
// plain "GitHub" — never a fabricated number.

import { useEffect, useState } from "react";
import { DownloadCTA } from "./DownloadCTA";

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.55 2.87 8.4 6.84 9.76.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05A9.36 9.36 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}

const fmtStars = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${n}`;

export function Nav({ repoUrl, stars }: { repoUrl: string; stars: number | null }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav className={`nav${scrolled ? " scrolled" : ""}`}>
      <div className="wrap">
        <a className="brand" href="#top" aria-label="GTM Grid — home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src="/brand/logo.svg" alt="GTM Grid" width={136} height={22} />
        </a>
        <div className="nav-links">
          <a className="nav-link" href="#how">How it works</a>
          <a className="nav-link" href="#connectors">Connectors</a>
          <a className="nav-link" href="#agent">Agent</a>
          <a className="nav-link" href="#source">Source</a>
          <a className="nav-link" href="#pricing">Pricing</a>
        </div>
        <div className="nav-actions">
          <a className="btn btn-ghost" href={repoUrl} target="_blank" rel="noreferrer">
            <GitHubIcon />
            {stars != null ? fmtStars(stars) : "GitHub"}
            {stars != null ? <span className="star-count">GitHub</span> : null}
          </a>
          <DownloadCTA label="Download" />
        </div>
      </div>
    </nav>
  );
}
