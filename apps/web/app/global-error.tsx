"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

/**
 * Root error boundary — catches errors thrown in the root layout itself, which
 * `error.tsx` cannot. It REPLACES the root layout, so it must render its own
 * <html>/<body>. Reports to PostHog then offers recovery.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    posthog.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
        }}
      >
        <h2 style={{ fontSize: 20, fontWeight: 600 }}>Something went wrong</h2>
        <p style={{ color: "#666", maxWidth: 420 }}>
          The app hit an unexpected error. Our team has been notified.
        </p>
        <button
          onClick={reset}
          style={{
            padding: "8px 18px",
            borderRadius: 8,
            border: "none",
            background: "#111",
            color: "#fff",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
