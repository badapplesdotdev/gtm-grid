// gtm grid brand mark — a bold geometric "G" monogram. Self-contained so it
// works as the sidebar logo and as the source for the app icon.
// If you have the exact brand vector, replace the <path> below with its data.

export function LogoMark({ size = 22, badge = true }: { size?: number; badge?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" aria-hidden="true">
      {badge && <rect x="0" y="0" width="96" height="96" rx="20" fill="#0d0d0f" />}
      {/* blocky G */}
      <path
        d="M22 18 H74 V35 H39 V61 H57 V51 H45 V42 H74 V78 H22 Z"
        fill="currentColor"
      />
      {/* grid pixel accent */}
      <rect x="63" y="63" width="11" height="11" rx="2" fill="var(--accent, #E60006)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="brand-wordmark">
      <LogoMark size={22} />
      <span>gtm grid</span>
    </span>
  );
}
