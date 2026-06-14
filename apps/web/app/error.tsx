"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

/**
 * Route-segment error boundary. React error boundaries intercept render errors
 * before they surface as window exceptions, so PostHog's autocapture never sees
 * them — report explicitly here. Renders a branded recovery UI with `reset()`.
 */
export default function Error({
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
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 24,
        textAlign: "center",
      }}
    >
      <h2 style={{ fontSize: 20, fontWeight: 600 }}>Something went wrong</h2>
      <p style={{ color: "#666", maxWidth: 420 }}>
        An unexpected error occurred. Our team has been notified. You can try again.
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
    </div>
  );
}
