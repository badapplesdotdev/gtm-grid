"use client";

// A connector favicon (Google s2) with a graceful monogram fallback. The design
// used inline `onerror` handlers to hide the <img> and reveal a sibling mono
// span; in React that's a tiny client component that flips state on error.

import { useState } from "react";
import { faviconUrl } from "./connectors";

export function Favicon({
  domain,
  mono,
  className = "conn-ico",
  wrapperStyle,
  imgStyle,
  fallbackStyle,
}: {
  /** Favicon domain; when omitted, only the monogram renders. */
  domain?: string;
  /** 2-letter fallback shown when there's no domain or the favicon fails. */
  mono: string;
  /** Wrapper class (the design reuses `.conn-ico` styling in several spots). */
  className?: string;
  wrapperStyle?: React.CSSProperties;
  imgStyle?: React.CSSProperties;
  fallbackStyle?: React.CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  const showImg = domain && !failed;
  return (
    <span className={className} style={wrapperStyle}>
      {showImg && (
        <img
          src={faviconUrl(domain)}
          alt=""
          loading="lazy"
          style={imgStyle}
          onError={() => setFailed(true)}
        />
      )}
      {!showImg && (
        <span className="conn-fallback" style={fallbackStyle}>
          {mono}
        </span>
      )}
    </span>
  );
}
