/**
 * Public shared-table page — `/share/<token>`.
 *
 * Where a recipient lands when someone shares a cloud table. The token is the
 * capability: no auth, no app install — anyone with the link sees the FROZEN
 * snapshot (all columns + all rows) read-only, and can hop into the desktop app
 * (`gtmgrid://share/<token>`) to clone it into their own project.
 *
 * Data source mirrors the invite page (TRI-3256): `loadSharePreview` runs the
 * PUBLIC `ShareService.getShareByToken` Effect in-process against the live
 * `appLayer` with `userId: null`. Three states: valid, invalid/expired, and a
 * graceful "couldn't load" fallback.
 *
 * `revalidate = 0` (always dynamic) so a revoked/expired link reflects
 * immediately rather than serving a cached snapshot.
 */

import { loadSharePreview } from "../../../lib/share-preview";
import { ShareGrid } from "./ShareGrid";
import styles from "./share.module.css";

export const revalidate = 0;

/** Brand wordmark — mirrors the invite/marketing header. */
function Wordmark() {
  return (
    <span className="wordmark">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="wordmark__mark"
        src="/brand/icon.png"
        alt=""
        width={16}
        height={16}
        aria-hidden="true"
      />
      GTM Grid
    </span>
  );
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await loadSharePreview(token);
  const preview = result.kind === "ok" ? result.preview : null;
  const valid = preview?.valid === true ? preview : null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Wordmark />
      </header>

      <main className={styles.main}>
        {valid ? (
          <>
            <div className={styles.eyebrow}>shared table</div>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>
                {valid.name ?? "Untitled table"}
              </h1>
              <a className={styles.cta} href={`gtmgrid://share/${token}`}>
                Open in GTM Grid
              </a>
            </div>
            <p className={styles.note}>
              A read-only snapshot of this table. Open it in GTM Grid to clone it
              into your own project — your AI agent can then set it up and run the
              columns with your own connector credentials.
            </p>
            <ShareGrid snapshot={valid.snapshot} />
          </>
        ) : result.kind === "unavailable" ? (
          <>
            <div className={styles.eyebrow}>shared table</div>
            <h1 className={styles.title}>Couldn&apos;t load this table</h1>
            <p className={styles.note}>
              The link looks right but we couldn&apos;t load it just now. Try
              again in a moment, or open it in the app.
            </p>
            <a className={styles.cta} href={`gtmgrid://share/${token}`}>
              Open in GTM Grid
            </a>
          </>
        ) : (
          <>
            <div className={styles.eyebrow}>shared table</div>
            <h1 className={styles.title}>This link is unavailable</h1>
            <p className={styles.note}>
              This share link is no longer valid — it may have been revoked or
              expired. Ask whoever shared it to send a fresh link.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
