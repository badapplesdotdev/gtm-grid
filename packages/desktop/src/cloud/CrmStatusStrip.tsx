/**
 * CRM sync status strip for a cloud table backed by an Attio binding.
 *
 * Mirrors {@link SignalStatusStrip}: renders nothing for tables with no CRM
 * bindings (the common case — one cheap cached query). For a synced table it
 * shows the source + last-sync summary, a "Sync now" (optimistic 'Syncing…',
 * then polls the run history until the newest run finishes and refreshes the
 * grid), a collapsible sync log, and — when the binding is paused — an amber
 * banner with the server's human error + the appropriate recovery action
 * (Reconnect Attio / Remove sync). Every error string comes from the server
 * already human-readable and is shown verbatim.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { openExternalUrl } from "./open-external";
import { useQuery as useReactQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import { BrandIcon } from "../BrandIcon";
import { gridQueryKeys } from "./useCloudGrid";

/** Provider display bits, keyed by the binding's stored provider string. */
const PROVIDER_DISPLAY: Record<string, { readonly name: string; readonly logo: string }> = {
  attio: { name: "Attio", logo: "https://www.google.com/s2/favicons?domain=attio.com&sz=128" },
  hubspot: { name: "HubSpot", logo: "https://www.google.com/s2/favicons?domain=hubspot.com&sz=128" },
};
const providerDisplay = (provider: string) => PROVIDER_DISPLAY[provider] ?? PROVIDER_DISPLAY.attio;

type PausedReason = null | "auth_revoked" | "source_gone" | "plan_lapsed";

/** Give a manual sync this long before the strip stops waiting (the run
 *  continues server-side; the sync log shows the eventual result). */
const SYNC_WAIT_CAP_MS = 5 * 60 * 1000;

/** A CRM binding on the table (crm.listBindings). */
interface CrmBinding {
  readonly id: string;
  readonly tableId: string;
  readonly provider: string;
  readonly sourceKind: "object" | "list";
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly columns: readonly { attrSlug: string; attrType: string; columnId: string; title: string }[];
  readonly config: Record<string, unknown> | null;
  readonly schedule: string | null;
  readonly enabled: boolean;
  readonly pausedReason: PausedReason;
  readonly lastSyncedAt: number | null;
  readonly lastError: string | null;
  readonly rowsSynced: number | null;
  readonly createdAt: number;
  /** Newest run summary (additive server field; absent on older servers). */
  readonly lastRun?: {
    readonly id: string;
    readonly status: string;
    readonly trigger: string;
    readonly rowsCreated: number;
    readonly rowsUpdated: number;
    readonly startedAt: number;
  } | null;
}

/** One sync run (crm.history). */
interface CrmRun {
  readonly id: string;
  readonly status: "running" | "ok" | "partial" | "warn" | "failed";
  readonly trigger: string;
  readonly rowsCreated: number;
  readonly rowsUpdated: number;
  readonly rowsSkipped: number;
  readonly rowsStaled: number;
  readonly fieldsDropped: string[] | null;
  readonly error: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
}

/** Compact relative timestamp. */
function agoLabel(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Open a URL in the system browser (Electron when packaged, else a new tab). */
export function CrmStatusStrip({ tableId, workspaceId, onUpgrade }: { tableId: string; workspaceId: string; onUpgrade?: () => void }) {
  const q = useReactQuery({
    queryKey: ["crm", "bindings", tableId],
    enabled: apiClient !== null && workspaceId !== "",
    queryFn: async (): Promise<readonly CrmBinding[]> => {
      // Null from an older/mock server = no bindings (never crash the grid).
      const res: unknown = await apiClient.crm.listBindings.query({ tableId });
      return Array.isArray(res) ? (res as readonly CrmBinding[]) : [];
    },
    staleTime: 5_000,
    // While ANY binding has a run in flight (cron/warm-up/manual), poll so the
    // strip reflects background syncs without a click.
    refetchInterval: (query) => {
      const data = query.state.data;
      return Array.isArray(data) && data.some((b) => b?.lastRun?.status === "running") ? 3000 : false;
    },
  });
  const bindings = q.data ?? [];
  if (bindings.length === 0) return null;
  return (
    <>
      {bindings.map((b) => (
        <CrmBindingRow key={b.id} binding={b} tableId={tableId} workspaceId={workspaceId} onUpgrade={onUpgrade} />
      ))}
    </>
  );
}

function CrmBindingRow({ binding, tableId, workspaceId, onUpgrade }: { binding: CrmBinding; tableId: string; workspaceId: string; onUpgrade?: () => void }) {
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // The newest run id at the moment Sync now was clicked. Completion means a
  // DIFFERENT (newly-created) run finished — otherwise the last finished run
  // would read as "done" the instant we start.
  const baselineRunIdRef = useRef<string | null>(null);
  const syncStartedAtRef = useRef<number | null>(null);

  // The match-key column's human title, resolved from the binding config.
  const matchKeyTitle = useMemo(() => {
    const attr = binding.config && typeof binding.config.matchKeyAttr === "string" ? binding.config.matchKeyAttr : null;
    if (!attr) return null;
    return binding.columns.find((c) => c.attrSlug === attr)?.title ?? null;
  }, [binding.config, binding.columns]);

  // History powers both the sync log AND the "Sync now" completion poll: while
  // syncing (or the log is open) refetch every 3s; idle otherwise.
  const historyQ = useReactQuery({
    queryKey: ["crm", "history", binding.id],
    enabled: showLog || syncing,
    queryFn: async (): Promise<readonly CrmRun[]> => {
      const res: unknown = await apiClient.crm.history.query({ bindingId: binding.id });
      return Array.isArray(res) ? (res as readonly CrmRun[]) : [];
    },
    refetchInterval: syncing ? 3000 : false,
  });
  const runs = historyQ.data ?? [];

  // Once a NEW run (id ≠ the pre-sync baseline) stops "running", the sync has
  // landed — refresh the grid + the binding summary, then drop 'Syncing…'.
  // Two escape hatches keep the spinner from trapping the strip forever:
  // a persistently failing history poll, and a hard cap on how long we wait
  // (the run itself keeps going server-side either way).
  useEffect(() => {
    if (!syncing) return;
    if (historyQ.isError) {
      setSyncing(false);
      setError("Couldn't check the sync's progress. It may still be running — open the sync log in a moment.");
      return;
    }
    if (syncStartedAtRef.current !== null && Date.now() - syncStartedAtRef.current > SYNC_WAIT_CAP_MS) {
      setSyncing(false);
      setError("This sync is taking a while. It's still running — check the sync log for the result.");
      return;
    }
    const newest = runs[0];
    if (newest && newest.id !== baselineRunIdRef.current && newest.status !== "running") {
      setSyncing(false);
      void Promise.all([
        qc.invalidateQueries({ queryKey: gridQueryKeys.tablePaged(tableId) }),
        qc.invalidateQueries({ queryKey: gridQueryKeys.table(tableId) }),
        qc.invalidateQueries({ queryKey: ["crm", "bindings", tableId] }),
      ]);
    }
  }, [syncing, runs, historyQ.isError, qc, tableId]);

  const syncNow = async () => {
    if (syncing) return; // double-click guard (state also disables the button)
    setError(null);
    // Disable SYNCHRONOUSLY — the baseline fetch below yields to the event
    // loop, and a fast double-click there would enqueue two runs.
    setSyncing(true);
    syncStartedAtRef.current = Date.now();
    try {
      // Baseline the current newest run BEFORE enqueuing so completion detection
      // waits for the fresh run rather than reading the last finished one.
      const current: unknown = await apiClient.crm.history.query({ bindingId: binding.id });
      baselineRunIdRef.current = Array.isArray(current) ? ((current[0] as CrmRun | undefined)?.id ?? null) : null;
      await apiClient.crm.syncNow.mutate({ bindingId: binding.id });
      await qc.invalidateQueries({ queryKey: ["crm", "history", binding.id] });
    } catch (e) {
      setSyncing(false);
      setError(e instanceof Error ? e.message : "Could not start the sync.");
    }
  };

  const crm = providerDisplay(binding.provider);

  const reconnect = async () => {
    setError(null);
    try {
      const provider = binding.provider === "hubspot" ? ("hubspot" as const) : ("attio" as const);
      const { url } = await apiClient.crm.authorizeUrl.query({ workspaceId, provider });
      await openExternalUrl(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not start the ${crm.name} connection.`);
    }
  };

  const removeSync = async () => {
    setError(null);
    try {
      await apiClient.crm.deleteBinding.mutate({ bindingId: binding.id });
      await qc.invalidateQueries({ queryKey: ["crm", "bindings", tableId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the sync.");
    }
  };

  // When a server-side run finishes (serverActive goes true→false), refresh
  // the grid, the table meta, and the sidebar counts — same keys the realtime
  // drop-backstop invalidates.
  const wasServerActiveRef = useRef(false);

  const paused = binding.pausedReason;
  // A run is in flight server-side (any trigger — cron, warm-up, manual from
  // anywhere). The local `syncing` click-state stays for instant feedback.
  const serverActive = binding.lastRun?.status === "running";
  const active = serverActive || syncing;
  const pulledSoFar = serverActive
    ? (binding.lastRun?.rowsCreated ?? 0) + (binding.lastRun?.rowsUpdated ?? 0)
    : null;

  useEffect(() => {
    if (serverActive) {
      wasServerActiveRef.current = true;
      return;
    }
    if (!wasServerActiveRef.current) return;
    wasServerActiveRef.current = false;
    void Promise.all([
      qc.invalidateQueries({ queryKey: gridQueryKeys.tablePaged(tableId) }),
      qc.invalidateQueries({ queryKey: gridQueryKeys.table(tableId) }),
      qc.invalidateQueries({ queryKey: ["grid", "tables"] }),
      qc.invalidateQueries({ queryKey: ["crm", "bindings", tableId] }),
    ]);
  }, [serverActive, qc, tableId]);

  return (
    <div className="crm-strip" role="status">
      <div className="crm-strip-row">
        <span className="crm-strip-logo"><BrandIcon logo={crm.logo} name={crm.name} size={15} /></span>
        <div className="crm-strip-main">
          <span className="crm-strip-title">
            Synced from {crm.name} · {binding.sourceLabel}
            <span className="crm-strip-kind">{binding.sourceKind === "list" ? "list" : "object"}</span>
          </span>
          {active ? (
            <span className="crm-strip-meta crm-strip-meta-sync">
              <span className="cell-spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} />
              Pulling records from {crm.name}…
              {pulledSoFar !== null && pulledSoFar > 0 ? ` ${pulledSoFar.toLocaleString()} so far` : ""}
            </span>
          ) : binding.lastSyncedAt === null ? (
            <span className="crm-strip-meta">first sync in progress…</span>
          ) : (
            <span className="crm-strip-meta">
              {(binding.rowsSynced ?? 0).toLocaleString()} records · pull-only
              {matchKeyTitle ? ` · matched on ${matchKeyTitle}` : ""}
              {` · last synced ${agoLabel(binding.lastSyncedAt)}`}
            </span>
          )}
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn btn-outline btn-sm" onClick={() => setShowLog((v) => !v)}>Sync log</button>
        <button className="btn btn-primary btn-sm" disabled={active} onClick={() => void syncNow()}>
          {active ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {/* Paused banners — the recovery path for a broken binding. */}
      {paused === "auth_revoked" && (
        <div className="crm-strip-banner crm-strip-banner-warn">
          <span className="crm-strip-banner-text">{binding.lastError ?? `${crm.name} access was revoked.`}</span>
          <button className="btn btn-outline btn-sm" onClick={() => void reconnect()}>Reconnect {crm.name}</button>
        </div>
      )}
      {paused === "plan_lapsed" && (
        <div className="crm-strip-banner crm-strip-banner-warn">
          <span className="crm-strip-banner-text">
            {binding.lastError ?? "Your plan doesn't include CRM sync right now. Upgrade to resume syncing."}
          </span>
          {onUpgrade ? (
            <button className="btn btn-outline btn-sm" onClick={onUpgrade}>View plans</button>
          ) : null}
        </div>
      )}
      {paused === "source_gone" && !confirmRemove && (
        <div className="crm-strip-banner crm-strip-banner-warn">
          <span className="crm-strip-banner-text">{binding.lastError ?? `This ${crm.name} source is no longer available.`}</span>
          <button className="btn btn-outline btn-sm" onClick={() => setConfirmRemove(true)}>Remove sync</button>
        </div>
      )}
      {paused === "source_gone" && confirmRemove && (
        <div className="crm-strip-banner crm-strip-banner-warn">
          <span className="crm-strip-banner-text">Remove this sync? The rows already in the grid stay.</span>
          <button className="btn btn-outline btn-sm" onClick={() => setConfirmRemove(false)}>Cancel</button>
          <button className="btn btn-danger btn-sm" onClick={() => void removeSync()}>Remove sync</button>
        </div>
      )}

      {error && <div className="crm-strip-error" role="alert">{error}</div>}

      {showLog && (
        <SyncHistoryPanel runs={runs} loading={historyQ.isLoading} schedule={binding.schedule} onRetry={() => void syncNow()} retryDisabled={syncing} providerName={crm.name} />
      )}
    </div>
  );
}

function SyncHistoryPanel({
  runs,
  loading,
  schedule,
  onRetry,
  retryDisabled,
  providerName,
}: {
  runs: readonly CrmRun[];
  loading: boolean;
  schedule: string | null;
  onRetry: () => void;
  retryDisabled: boolean;
  providerName: string;
}) {
  return (
    <div className="crm-history">
      <div className="crm-history-head">
        <span className="crm-history-label">Sync history</span>
        {schedule && <span className="crm-history-schedule">Runs {schedule} · 09:00 UTC</span>}
      </div>
      {loading && runs.length === 0 ? (
        <div className="crm-history-loading"><span className="cell-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /></div>
      ) : runs.length === 0 ? (
        <div className="crm-history-empty">No sync runs yet.</div>
      ) : (
        <div className="crm-history-list">
          {runs.map((r) => <HistoryEntry key={r.id} run={r} onRetry={onRetry} retryDisabled={retryDisabled} providerName={providerName} />)}
        </div>
      )}
    </div>
  );
}

function HistoryEntry({ run, onRetry, retryDisabled, providerName }: { run: CrmRun; onRetry: () => void; retryDisabled: boolean; providerName: string }) {
  const dot = run.status === "ok" ? "ok" : run.status === "failed" ? "err" : run.status === "running" ? "run" : "warn";
  const title =
    run.status === "failed" ? "Sync failed"
      : run.status === "running" ? "Syncing…"
        : `Synced ${(run.rowsCreated + run.rowsUpdated).toLocaleString()} records`;

  const detailParts: string[] = [];
  if (run.status !== "running" && run.status !== "failed") {
    detailParts.push(`${run.rowsCreated} new`, `${run.rowsUpdated} updated`);
    if (run.rowsStaled > 0) detailParts.push(`${run.rowsStaled} no longer in ${providerName}`);
  }
  if (run.error) detailParts.push(run.error);
  if (run.fieldsDropped && run.fieldsDropped.length > 0) detailParts.push(`dropped: ${run.fieldsDropped.join(", ")}`);
  const detail = detailParts.join(" · ");

  const canRetry = run.status === "warn" || run.status === "partial" || run.status === "failed";
  const when = run.finishedAt ?? run.startedAt;

  return (
    <div className="crm-history-entry">
      <span className={`crm-history-dot crm-history-dot-${dot}`} />
      <div className="crm-history-body">
        <div className="crm-history-title-row">
          <span className="crm-history-title">{title}</span>
          {run.status === "partial" && <span className="crmw-chip crm-history-chip">partial</span>}
        </div>
        {detail && <div className="crm-history-detail">{detail}</div>}
      </div>
      <span className="crm-history-time">{agoLabel(when)}</span>
      {canRetry && (
        <button className="btn btn-outline btn-sm" disabled={retryDisabled} onClick={onRetry}>Retry</button>
      )}
    </div>
  );
}
