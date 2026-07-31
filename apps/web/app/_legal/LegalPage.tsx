import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared chrome for the legal pages (/terms, /privacy).
 *
 * Both documents previously repeated this wordmark + header block verbatim,
 * which meant a brand or layout change had to be made twice and the two pages
 * could silently drift apart. Body copy stays in each page — only the frame is
 * shared.
 */
export function LegalPage({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <main className="container prose">
      <Link className="wordmark prose__home" href="/">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="wordmark__mark"
          src="/brand/icon.png"
          alt=""
          width={16}
          height={16}
          aria-hidden="true"
        />
        GTM Grid
      </Link>

      <header className="prose__head">
        <span className="eyebrow">legal</span>
        <h1>{title}</h1>
        <p className="prose__lede">Last updated: {lastUpdated}</p>
      </header>

      {children}
    </main>
  );
}
