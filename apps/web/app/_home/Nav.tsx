"use client";

// Sticky top nav. Client-only for the one bit of behaviour it owns: a shadow
// that appears once the page is scrolled past 8px (`.scrolled`).

import { useEffect, useState } from "react";
import { BrandMark, GitHubMark, DiscordMark, DownloadArrow } from "./icons";

const LINKS = [
  ["#how", "How it works"],
  ["#surfaces", "Surfaces"],
  ["#connectors", "Connectors"],
  ["#agent", "Agent"],
  ["#local", "Source"],
  ["#pricing", "Pricing"],
] as const;

const REPO = "https://github.com/badapplesdotdev/gtm-grid";
const DISCORD = "https://discord.gg/xTEb65XQb";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav className={`nav${scrolled ? " scrolled" : ""}`} id="nav">
      <div className="wrap">
        <a className="brand" href="#top" aria-label="Grid — home">
          <BrandMark />
          <span className="brand-name">Grid</span>
        </a>
        <div className="nav-links">
          {LINKS.map(([href, label]) => (
            <a className="nav-link" href={href} key={href}>
              {label}
            </a>
          ))}
        </div>
        <div className="nav-actions">
          <a className="btn btn-ghost" href={REPO}>
            <GitHubMark />
            GitHub
          </a>
          <a className="btn btn-ghost" href={DISCORD}>
            <DiscordMark />
            Community
          </a>
          <a className="btn btn-primary" href="#download">
            <DownloadArrow />
            Download
          </a>
        </div>
      </div>
    </nav>
  );
}
