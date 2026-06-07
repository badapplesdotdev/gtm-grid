// Full-page app loader — the canonical loading screen. Use this anywhere the
// whole view is blocked on a load (session resolution, engine boot, route swap)
// instead of a bare spinner. It animates the real brand mark: the three brand
// chevrons (gtm_grid_logo.svg / Logo.tsx) pulse in sequence over a soft breathing
// scale, so the wait reads as "GTM Grid", not a generic throbber.

const BRAND_GREEN = "#22C55E";

/**
 * The animated brand mark on its own (no full-page chrome). Handy for inline
 * "section is loading" spots that still want the branded animation.
 */
export function BrandLoaderMark({ size = 48 }: { size?: number }) {
  return (
    <svg
      className="brand-loader-mark"
      width={size}
      height={size}
      viewBox="0 0 213 203"
      fill="none"
      role="img"
      aria-label="Loading"
    >
      <g fill={BRAND_GREEN}>
        <path
          className="brand-loader-chevron"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M62.9001 0.959961H171.36L140.37 54.6299H31.9102L62.9001 0.959961Z"
        />
        <path
          className="brand-loader-chevron"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M212.09 94.8899L181.1 148.57L157.86 108.31H109.38L140.37 54.6299H188.85L212.09 94.8899Z"
        />
        <path
          className="brand-loader-chevron"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M86.1399 148.56H181.1L150.11 202.24H55.1499L0.919922 108.31L31.9099 54.6299L86.1399 148.56Z"
        />
      </g>
    </svg>
  );
}

/**
 * Full-viewport branded loader. `label` is an optional caption under the mark;
 * `inShell` adds the `app-shell` class so it slots into the same layout box the
 * real app uses (matches the auth gate).
 */
export function AppLoader({
  label,
  size = 56,
  inShell = false,
}: {
  label?: string;
  size?: number;
  inShell?: boolean;
}) {
  return (
    <div
      className={`app-loader${inShell ? " app-shell" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <BrandLoaderMark size={size} />
      {label ? <p className="app-loader-label">{label}</p> : null}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
