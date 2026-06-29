// Full-screen engine-failure screen. Shown when the local engine (sidecar) never
// becomes reachable during INITIAL boot (offline past the cold-start grace) —
// instead of flashing the topbar offline banner before the shell renders. Mirrors
// AppLoader's full-page layout so it reads as the same branded state. It is not a
// dead end: the boot poll keeps retrying in the background, so a successful health
// check flips the app straight to the shell, and Retry re-triggers the poll now.
import { LogoMark } from "./Logo";

export function AppError({
  dev,
  onRetry,
  onCopyDiagnostics,
  copied,
}: {
  /** Dev build → show the local-server command; packaged → a restart message. */
  dev: boolean;
  onRetry: () => void;
  onCopyDiagnostics: () => void;
  copied: boolean;
}) {
  return (
    <div className="app-error app-shell" role="alert" aria-live="assertive">
      <div className="app-error-card">
        <LogoMark size={40} />
        <h1 className="app-error-title">GTM Grid couldn’t start its engine</h1>
        {dev ? (
          <p className="app-error-message">
            The local engine isn’t running. Start it with{" "}
            <code>pnpm --filter @gtmgrid/server dev</code>, then retry.
          </p>
        ) : (
          <p className="app-error-message">
            The local engine didn’t start. Restarting GTM Grid usually fixes this —
            if it keeps happening, send us the diagnostics below.
          </p>
        )}
        <div className="app-error-actions">
          <button
            type="button"
            className="app-error-btn app-error-btn--primary"
            onClick={onRetry}
          >
            Retry
          </button>
          <button type="button" className="app-error-btn" onClick={onCopyDiagnostics}>
            {copied ? "Copied ✓" : "Copy diagnostics"}
          </button>
        </div>
      </div>
    </div>
  );
}
