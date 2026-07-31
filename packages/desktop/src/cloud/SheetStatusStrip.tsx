/**
 * Compact status and manual refresh control for Google Sheet-backed tables.
 * Renders nothing for ordinary tables, keeping the common grid path unchanged.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import { gridQueryKeys } from "./useCloudGrid";

type Schedule = "manual" | "hourly" | "daily" | "weekly";

interface SheetBinding {
  readonly id: string;
  readonly tableId: string;
  readonly spreadsheetId: string;
  readonly spreadsheetName: string;
  readonly sheetTitle: string;
  readonly schedule: Schedule;
  readonly enabled: boolean;
  readonly pausedReason: string | null;
  readonly lastSyncedAt: number | null;
  readonly lastError: string | null;
  readonly rowsSynced: number | null;
}

interface SyncResult {
  readonly rowsCreated: number;
  readonly rowsUpdated: number;
  readonly rowsSkipped: number;
  readonly truncated: boolean;
}

const SCHEDULE_LABELS: Record<Schedule, string> = {
  manual: "Manual",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
};

function bindingsFrom(value: unknown): readonly SheetBinding[] {
  if (typeof value !== "object" || value === null || !("bindings" in value)) return [];
  const bindings = value.bindings;
  return Array.isArray(bindings) ? (bindings as readonly SheetBinding[]) : [];
}

export function SheetStatusStrip({ tableId, workspaceId }: { tableId: string; workspaceId: string }) {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ bindingId: string; result: SyncResult } | null>(null);
  const queryKey = ["sheets", "bindings", tableId] as const;

  const query = useQuery({
    queryKey,
    enabled: apiClient !== null && workspaceId !== "",
    queryFn: async () => bindingsFrom(
      await apiClient!.sheets.listForTable.query({ workspaceId, tableId }),
    ),
    staleTime: 15_000,
  });
  const bindings = query.data ?? [];
  if (bindings.length === 0) return null;

  const syncNow = async (binding: SheetBinding) => {
    if (apiClient === null || syncing !== null) return;
    setSyncing(binding.id);
    setError(null);
    setLastResult(null);
    try {
      const result = await apiClient.sheets.syncNow.mutate({
        workspaceId,
        bindingId: binding.id,
      });
      setLastResult({ bindingId: binding.id, result });
      // Sheets writes happen server-side, beyond the grid mutation hooks. Keep
      // the open page, unpaged fallback, sidebar counts, and status in lockstep.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: gridQueryKeys.table(tableId) }),
        queryClient.invalidateQueries({ queryKey: gridQueryKeys.tablePaged(tableId) }),
        queryClient.invalidateQueries({
          predicate: ({ queryKey: key }) => key[0] === "grid" && key[1] === "tables",
        }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sync this spreadsheet.");
    } finally {
      setSyncing(null);
    }
  };

  return (
    <div className="sheet-strip signal-strip" role="status">
      {bindings.map((binding) => {
        const active = syncing === binding.id;
        const unavailable = !binding.enabled || binding.pausedReason !== null;
        const result = lastResult?.bindingId === binding.id ? lastResult.result : null;
        const sourceName = binding.spreadsheetName || binding.spreadsheetId;
        return (
          <div key={binding.id} className="sheet-strip-entry">
            <div className="sheet-strip-row signal-strip-row">
              <span
                className="signal-strip-dot"
                data-state={binding.lastError || binding.pausedReason ? "error" : binding.lastSyncedAt ? "ok" : "warming"}
              />
              <span className="sheet-strip-source signal-strip-label">
                {sourceName} · {binding.sheetTitle}
              </span>
              <span className="sheet-strip-meta signal-strip-meta">
                {(binding.rowsSynced ?? 0).toLocaleString()} rows synced · {SCHEDULE_LABELS[binding.schedule]}
              </span>
              <button
                className="btn btn-outline btn-sm"
                disabled={active || unavailable}
                onClick={() => void syncNow(binding)}
                title={unavailable ? "This Sheet sync is paused" : "Pull the latest rows from Google Sheets"}
              >
                {active ? "Syncing…" : "Sync now"}
              </button>
            </div>
            {result && (
              <div className="sheet-strip-result">
                {result.rowsCreated.toLocaleString()} new · {result.rowsUpdated.toLocaleString()} updated · {result.rowsSkipped.toLocaleString()} unchanged
                {result.truncated ? " · row limit reached" : ""}
              </div>
            )}
            {(binding.lastError || binding.pausedReason) && (
              <div className="signal-strip-error" role="alert">
                {binding.lastError ?? "This Sheet sync is paused."}
              </div>
            )}
          </div>
        );
      })}
      {error && <div className="signal-strip-error" role="alert">{error}</div>}
    </div>
  );
}
