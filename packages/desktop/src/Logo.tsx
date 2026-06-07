// GTM Grid brand mark — the geometric chevron icon from the Anymark brand kit
// (/DESIGN.md, gtm_grid_logo.svg). Self-contained inline SVG so it ships offline
// and works as both the sidebar logo and the source for the app icon tile.

const BRAND_GREEN = "#22C55E";

export function LogoMark({
  size = 22,
  badge = false,
  color = BRAND_GREEN,
}: {
  size?: number;
  badge?: boolean;
  color?: string;
}) {
  // viewBox matches the brand icon artwork (213×203). On a dark badge the mark
  // stays brand green; standalone it inherits the passed color.
  return (
    <svg width={size} height={size} viewBox="0 0 213 203" fill="none" aria-hidden="true">
      {badge && <rect x="-12" y="-16" width="237" height="237" rx="44" fill="#0d0d0f" />}
      <g fill={color}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M62.9001 0.959961H171.36L140.37 54.6299H31.9102L62.9001 0.959961Z"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M86.1399 148.56H181.1L150.11 202.24H55.1499L0.919922 108.31L31.9099 54.6299L86.1399 148.56Z"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M212.09 94.8899L181.1 148.57L157.86 108.31H109.38L140.37 54.6299H188.85L212.09 94.8899Z"
        />
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="brand-wordmark">
      <LogoMark size={22} />
      <span>GTM Grid</span>
    </span>
  );
}
