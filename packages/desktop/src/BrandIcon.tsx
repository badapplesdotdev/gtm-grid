import { useState, useEffect } from "react";

function initials(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "··";
}

/** Brand logo with a graceful fallback to monogram initials if it fails to load.
 *
 * Lives in its own module (rather than Panels.tsx) so it can be imported
 * eagerly into the initial bundle while the heavier Panels.* gallery/detail
 * components are lazy-loaded via React.lazy. */
export function BrandIcon({ logo, name, size = 18 }: { logo: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [logo]);
  if (logo && !failed) {
    return (
      <img className="brand-img" src={logo} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />
    );
  }
  return <span className="brand-fallback" style={{ width: size, height: size }}>{initials(name)}</span>;
}
