import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PipelineGraphPatch } from "@gtmgrid/pipelines";
import { useCallback } from "react";
import { apiClient } from "./client";

export const pipelineQueryKeys = {
  list: (projectId: string) => ["pipelines", "list", projectId] as const,
  detail: (pipelineId: string) => ["pipelines", "detail", pipelineId] as const,
  runs: (pipelineId: string) => ["pipelines", "runs", pipelineId] as const,
  run: (runId: string) => ["pipelines", "run", runId] as const,
  tableBindings: (tableId: string) => ["pipelines", "table-bindings", tableId] as const,
};

export function useTablePipelineBindings(tableId: string | null) {
  return useQuery({
    queryKey: pipelineQueryKeys.tableBindings(tableId ?? ""),
    enabled: tableId !== null,
    queryFn: () => apiClient.pipelines.tableBindings.query({ tableId: tableId as string }),
  });
}

export function usePipelines(projectId: string | null) {
  return useQuery({
    queryKey: pipelineQueryKeys.list(projectId ?? ""),
    enabled: projectId !== null,
    queryFn: () => apiClient.pipelines.list.query({ projectId: projectId as string }),
  });
}

export function usePipeline(pipelineId: string | null) {
  return useQuery({
    queryKey: pipelineQueryKeys.detail(pipelineId ?? ""),
    enabled: pipelineId !== null,
    queryFn: () => apiClient.pipelines.get.query({ pipelineId: pipelineId as string }),
  });
}

export function usePipelineRuns(pipelineId: string | null) {
  return useQuery({
    queryKey: pipelineQueryKeys.runs(pipelineId ?? ""),
    enabled: pipelineId !== null,
    refetchInterval: (query) => query.state.data?.some((run) =>
      ["queued", "running", "pausing", "cancelling"].includes(run.status),
    ) ? 2_000 : false,
    queryFn: () => apiClient.pipelines.listRuns.query({ pipelineId: pipelineId as string, limit: 50 }),
  });
}

export function usePipelineRun(runId: string | null) {
  return useQuery({
    queryKey: pipelineQueryKeys.run(runId ?? ""),
    enabled: runId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === undefined || ["queued", "running", "pausing", "cancelling"].includes(status) ? 350 : false;
    },
    queryFn: () => apiClient.pipelines.getRun.query({ runId: runId as string }),
  });
}

export function usePipelineMutations(projectId: string | null) {
  const queryClient = useQueryClient();
  const invalidate = useCallback(
    async (pipelineId?: string) => {
      if (projectId) await queryClient.invalidateQueries({ queryKey: pipelineQueryKeys.list(projectId) });
      if (pipelineId) await queryClient.invalidateQueries({ queryKey: pipelineQueryKeys.detail(pipelineId) });
    },
    [projectId, queryClient],
  );
  return {
    create: async (name: string) => {
      if (!projectId) throw new Error("Open a project before creating a pipeline.");
      const result = await apiClient.pipelines.create.mutate({ projectId, name });
      await invalidate(result.pipeline.id);
      return result;
    },
    remove: async (pipelineId: string) => {
      const result = await apiClient.pipelines.remove.mutate({ pipelineId });
      await queryClient.removeQueries({ queryKey: pipelineQueryKeys.detail(pipelineId) });
      if (projectId) await queryClient.invalidateQueries({ queryKey: pipelineQueryKeys.list(projectId) });
      return result;
    },
    patchDraft: async (pipelineId: string, patches: readonly PipelineGraphPatch[]) => {
      const mutablePatches = patches.map((patch) =>
        patch.op === "replace_node_edges"
          ? { ...patch, edges: [...patch.edges] }
          : patch,
      );
      const result = await apiClient.pipelines.patchDraft.mutate({ pipelineId, patches: mutablePatches });
      await invalidate(pipelineId);
      return result;
    },
    deploy: async (pipelineId: string) => {
      const result = await apiClient.pipelines.deploy.mutate({ pipelineId });
      await invalidate(pipelineId);
      return result;
    },
    attach: async (input: {
      pipelineId: string;
      versionId: string;
      tableId: string;
      inputMapping: Record<string, string>;
      outputMapping: Record<string, string>;
      executionTarget: "local" | "cloud";
      autoRun: boolean;
    }) => {
      const result = await apiClient.pipelines.attach.mutate(input);
      await invalidate(input.pipelineId);
      return result;
    },
    createRun: async (input: {
      pipelineId: string;
      versionId: string;
      bindingId: string;
      tableId: string;
      executionTarget: "local" | "cloud";
      totalRecords: number;
      rowIds?: string[];
      writeOutputs?: boolean;
    }) => {
      const { rowIds, writeOutputs, ...runInput } = input;
      const result = await apiClient.pipelines.createRun.mutate({ ...runInput, trigger: "manual", selection: { ...(rowIds ? { rowIds } : {}), ...(writeOutputs === undefined ? {} : { writeOutputs }) } });
      await queryClient.invalidateQueries({ queryKey: pipelineQueryKeys.runs(input.pipelineId) });
      return result;
    },
  };
}
