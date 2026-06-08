"use client";

// Design-styled twin of app/DownloadButton.tsx: detects the visitor's OS and
// points at the matching installer via `/api/download/<platform>` (which 302s to
// the latest GitHub release asset), falling back to the full `/download` page on
// mobile or an unknown OS. Renders the design's `.btn .btn-primary` classes (not
// the globals `.btn--primary`) so it lives inside the scoped `.gtm-home` styles.

import { useEffect, useState } from "react";

type Detected = { readonly key: string; readonly os: string } | null;

function detectOS(): Detected {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return null; // no desktop build
  if (/Mac/i.test(ua)) return { key: "mac-arm", os: "macOS" }; // default Apple Silicon
  if (/Win/i.test(ua)) return { key: "windows", os: "Windows" };
  if (/Linux/i.test(ua)) return { key: "linux", os: "Linux" };
  return null;
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
    </svg>
  );
}

export function DownloadCTA({
  size,
  label,
  className,
}: {
  size?: "lg";
  /** Override the computed "Download for <OS>" label (e.g. "Download free"). */
  label?: string;
  className?: string;
}) {
  const [detected, setDetected] = useState<Detected>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setDetected(detectOS());
    setReady(true);
  }, []);

  const href = detected ? `/api/download/${detected.key}` : "/download";
  const computed = !ready
    ? "Download"
    : detected
      ? `Download for ${detected.os}`
      : "Download the app";

  return (
    <a
      className={`btn btn-primary${size === "lg" ? " btn-lg" : ""}${className ? ` ${className}` : ""}`}
      href={href}
      data-detected={detected?.key ?? "none"}
    >
      <DownloadIcon />
      {label ?? computed}
    </a>
  );
}
