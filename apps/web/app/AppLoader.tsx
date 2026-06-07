// Full-page branded loader for the marketing/web app — the canonical loading
// screen. Mirrors packages/desktop/src/AppLoader.tsx: the three brand chevrons
// (gtm_grid_logo.svg) pulse in sequence over a soft breathing scale. Use as a
// route-level loading.tsx fallback or wherever a full page is blocked on a load.
// Pure CSS animation, so it stays a server component (no "use client").

const BRAND_GREEN = "#22c55e";

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

export function AppLoader({ label, size = 56 }: { label?: string; size?: number }) {
  return (
    <div className="app-loader" role="status" aria-live="polite" aria-busy="true">
      <BrandLoaderMark size={size} />
      {label ? <p className="app-loader-label">{label}</p> : null}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
