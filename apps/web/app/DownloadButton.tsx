"use client";

// The hero's smart download CTA: detects the visitor's OS and points at the
// matching installer via `/api/download/<platform>` (which 302s to the latest
// GitHub release asset). Falls back to the full `/download` page on mobile or an
// unknown OS. Detection is client-only, so the button renders a neutral label
// during SSR/first paint, then upgrades on mount.

import { useEffect, useState } from "react";
import posthog from "posthog-js";

type Detected = { readonly key: string; readonly os: string } | null;

function detectOS(): Detected {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return null; // no desktop build
  if (/Mac/i.test(ua)) return { key: "mac-arm", os: "macOS" }; // default Apple Silicon; Intel on /download
  if (/Win/i.test(ua)) return { key: "windows", os: "Windows" };
  if (/Linux/i.test(ua)) return { key: "linux", os: "Linux" };
  return null;
}

export function DownloadButton() {
  const [detected, setDetected] = useState<Detected>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setDetected(detectOS());
    setReady(true);
  }, []);

  const href = detected ? `/api/download/${detected.key}` : "/download";
  const label = !ready
    ? "Download"
    : detected
      ? `Download for ${detected.os}`
      : "Download the app";

  function handleClick() {
    posthog.capture("download_initiated", {
      platform: detected?.key ?? "unknown",
      os: detected?.os ?? "unknown",
    });
  }

  return (
    <a className="btn btn--primary" href={href} data-detected={detected?.key ?? "none"} onClick={handleClick}>
      {label}
    </a>
  );
}
