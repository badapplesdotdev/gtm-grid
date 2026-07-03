"use client";

// The hero's smart download CTA: detects the visitor's OS and points at the
// matching installer via `/api/download/<platform>` (which 302s to the latest
// GitHub release asset). Falls back to the full `/download` page on mobile or an
// unknown OS. Detection is client-only, so the button renders a neutral label
// during SSR/first paint, then upgrades on mount.
//
// The per-platform download is a 302 to a binary, so the page never changes on
// click — the button surfaces its own feedback (spinner → "Download started" +
// a fallback link) so it doesn't feel dead. Shares OS detection / href logic
// with the design twin app/_home/DownloadCTA.tsx via `@/lib/download`.

import { useEffect, useRef, useState } from "react";
import posthog from "posthog-js";
import { detectOS, resolveDownload, type DetectedOS } from "@/lib/download";

type Phase = "idle" | "starting" | "started";

export function DownloadButton() {
  const [detected, setDetected] = useState<DetectedOS>(null);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDetected(
      detectOS(typeof navigator === "undefined" ? undefined : navigator.userAgent),
    );
    setReady(true);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const target = resolveDownload(detected);
  const label = !ready
    ? "Download"
    : detected
      ? `Download for ${detected.os}`
      : "Download the app";

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

  const text =
    phase === "starting"
      ? "Starting…"
      : phase === "started"
        ? "Download started"
        : label;

  return (
    <span className="dl-btn">
      <a
        className="btn btn--primary"
        href={target.href}
        data-detected={detected?.key ?? "none"}
        aria-disabled={phase === "starting" || undefined}
        onClick={handleClick}
      >
        {phase === "starting" && <span className="dl-btn__spinner" aria-hidden="true" />}
        {text}
      </a>
      {phase !== "idle" && (
        <span className="dl-btn__hint" role="status" aria-live="polite">
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
