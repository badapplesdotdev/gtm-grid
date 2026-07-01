"use client";

// Design-styled twin of app/DownloadButton.tsx: detects the visitor's OS and
// points at the matching installer via `/api/download/<platform>` (which 302s to
// the latest GitHub release asset), falling back to the full `/download` page on
// mobile or an unknown OS. Renders the design's `.btn .btn-primary` classes (not
// the globals `.btn--primary`) so it lives inside the scoped `.gtm-home` styles.

import { useEffect, useState } from "react";
import posthog from "posthog-js";
import { AppleMark, WindowsMark } from "./icons";

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

/** Apple + Windows glyphs, signalling the build ships for both desktops. */
function PlatformIcons() {
  return (
    <span className="dl-os-icons" aria-hidden="true">
      <AppleMark />
      <WindowsMark />
    </span>
  );
}

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
  const [detected, setDetected] = useState<Detected>(null);
  useEffect(() => {
    setDetected(detectOS());
  }, []);

  const href = detected ? `/api/download/${detected.key}` : "/download";
  // Cross-platform build — keep the label plain and let the Apple + Windows
  // icons signal that it covers both desktops (href still routes per-OS).
  const computed = "Download";

  function handleClick() {
    posthog.capture("download_initiated", {
      platform: detected?.key ?? "unknown",
      os: detected?.os ?? "unknown",
    });
  }

  return (
    <a
      className={`btn btn-primary${size === "lg" ? " btn-lg" : ""}${className ? ` ${className}` : ""}`}
      href={href}
      data-detected={detected?.key ?? "none"}
      onClick={handleClick}
    >
      <PlatformIcons />
      {label ?? computed}
    </a>
  );
}
