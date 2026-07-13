"use client";

// Design-styled twin of app/DownloadButton.tsx: detects the visitor's OS and
// points at the matching installer via `/api/download/<platform>` (which 302s to
// the latest GitHub release asset), falling back to the full `/download` page on
// mobile or an unknown OS. Renders the design's `.btn .btn-primary` classes (not
// the globals `.btn--primary`) so it lives inside the scoped `.gtm-home` styles.
//
// Because the per-platform download is a 302 to a binary, the browser starts a
// file download and the page never changes — so the click gives an on-screen
// acknowledgement (spinner → "Download started" + a fallback link) instead of
// feeling dead. OS detection / href logic is shared via `@/lib/download`.

import { useEffect, useRef, useState } from "react";
import posthog from "posthog-js";
import { AppleMark, Check, WindowsMark } from "./icons";
import { detectOS, resolveDownload, type DetectedOS } from "@/lib/download";

/** Apple + Windows glyphs, signalling the build ships for both desktops. */
function PlatformIcons() {
  return (
    <span className="dl-os-icons" aria-hidden="true">
      <AppleMark />
      <WindowsMark />
    </span>
  );
}

type Phase = "idle" | "starting" | "started";

export function DownloadCTA({
  size,
  label,
  className,
}: {
  size?: "lg";
  /** Override the default "Download" label (e.g. "Download free"). */
  label?: string;
  className?: string;
}) {
  const [detected, setDetected] = useState<DetectedOS>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDetected(
      detectOS(typeof navigator === "undefined" ? undefined : navigator.userAgent),
    );
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const target = resolveDownload(detected);
  // Cross-platform build — keep the label plain and let the Apple + Windows
  // icons signal that it covers both desktops (href still routes per-OS).
  const computed = "Download";

  function handleClick() {
    posthog.capture("download_initiated", {
      platform: target.platform,
      os: target.os,
    });
    // Navigating to the /download page is its own feedback; only the in-page
    // binary download (page stays put) needs an on-screen acknowledgement.
    if (!target.startsInPageDownload) return;
    setPhase("starting");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPhase("started"), 1200);
  }

  const inner =
    phase === "starting" ? (
      <>
        <span className="dl-spinner" aria-hidden="true" />
        Starting…
      </>
    ) : phase === "started" ? (
      <>
        <Check aria-hidden="true" />
        Download started
      </>
    ) : (
      <>
        <PlatformIcons />
        {label ?? computed}
      </>
    );

  return (
    <span className="dl-cta">
      <a
        className={`btn btn-primary${size === "lg" ? " btn-lg" : ""}${className ? ` ${className}` : ""}`}
        href={target.href}
        data-detected={detected?.key ?? "none"}
        aria-disabled={phase === "starting" || undefined}
        onClick={handleClick}
      >
        {inner}
      </a>
      {phase !== "idle" && (
        <span className="dl-cta-hint" role="status" aria-live="polite">
          Your download should begin shortly. If it doesn&rsquo;t,{" "}
          <a href={target.href} onClick={handleClick}>
            click here
          </a>
          .
        </span>
      )}
    </span>
  );
}
