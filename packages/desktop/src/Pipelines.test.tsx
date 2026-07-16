// @vitest-environment jsdom
//
// Component coverage for the pipeline UI — the "creating pipelines" + "canvas
// editor" journeys the run-path tests don't touch. The data layer
// (`./cloud/usePipelines`, `./api`, the tRPC client) is mocked so the REAL
// `PipelinesHub` / `PipelineEditor` render and their interactions
// (create → open, edit graph, deploy) are asserted against the mocked mutations.

import { PIPELINE_SCHEMA_VERSION, type PipelineGraph } from "@gtmgrid/pipelines";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks for the data layer + heavy leaf imports ────────────────────────────
const mutations = {
  create: vi.fn(async (_name: string) => ({ pipeline: { id: "pl-new", name: "Untitled pipeline" } })),
  remove: vi.fn(),
  patchDraft: vi.fn(async () => ({})),
  deploy: vi.fn(async (_id: string) => ({ version: 2 })),
  attach: vi.fn(),
  createRun: vi.fn(),
};

// Per-test overridable query results.
const hookState: {
  pipelines: { data: unknown; isLoading: boolean; error: unknown };
  pipeline: { data: unknown };
  runs: { data: unknown };
  run: { data: unknown };
} = {
  pipelines: { data: [], isLoading: false, error: null },
  pipeline: { data: null },
  runs: { data: [] },
  run: { data: null },
};

vi.mock("./cloud/usePipelines", () => ({
  usePipelines: () => hookState.pipelines,
  usePipeline: () => hookState.pipeline,
  usePipelineRuns: () => hookState.runs,
  usePipelineRun: () => hookState.run,
  usePipelineMutations: () => mutations,
  useTablePipelineBindings: () => ({ data: [] }),
}));

vi.mock("./api", () => ({
  api: { functions: vi.fn(async () => []), aiProviders: vi.fn(async () => []) },
}));

vi.mock("./cloud/client", () => ({
  apiClient: { grid: { getTablePage: { query: vi.fn(async () => ({ table: { name: "T" }, columns: [], rows: [], cells: [] })) } } },
}));

// Leaf components that pull in unrelated heavy trees — render as no-ops.
vi.mock("./AddColumn", () => ({ FunctionsModal: () => null }));

import { PipelinesHub, PipelineEditor } from "./Pipelines";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
beforeEach(() => {
  hookState.pipelines = { data: [], isLoading: false, error: null };
  hookState.pipeline = { data: null };
  hookState.runs = { data: [] };
  hookState.run = { data: null };
});

// A clean, output-node-free draft graph (avoids the editor's legacy-migration
// patch on mount, so `patchDraft` is only called by our interactions).
const draftGraph: PipelineGraph = {
  schemaVersion: PIPELINE_SCHEMA_VERSION,
  nodes: [
    { id: "input", type: "input", name: "Company", position: { x: 0, y: 0 }, config: { key: "company", required: true } },
    { id: "normalize", type: "formula", name: "Normalize", position: { x: 240, y: 0 }, config: { expression: "company" } },
  ],
  edges: [{ id: "e1", source: "input", target: "normalize" }],
};

const compiledPlan = {
  capabilities: { local: true, cloud: true, reasons: [] },
  actionEstimate: { minimumPerRecord: 0, expectedPerRecord: 1, maximumPerRecord: 1, billableNodeIds: [] },
};
const pipelineDetail = {
  pipeline: { id: "pl-1", name: "Enrich companies" },
  draft: { id: "ver-draft", version: 1, status: "draft", graph: draftGraph, compiledPlan },
  deployed: null,
  bindings: [],
};

describe("PipelinesHub — creating pipelines", () => {
  it("shows the empty state and creates + opens a pipeline", async () => {
    const onOpen = vi.fn();
    render(<PipelinesHub projectId="proj-1" onOpen={onOpen} />);

    // Empty state affordance.
    expect(screen.getByText(/your automation layer starts here/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /new pipeline/i }));

    expect(mutations.create).toHaveBeenCalledWith("Untitled pipeline");
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("pl-new"));
  });

  it("renders a card per pipeline from the query", () => {
    hookState.pipelines = {
      data: [{ id: "pl-1", name: "Enrich companies", description: "", updatedAt: Date.now() }],
      isLoading: false,
      error: null,
    };
    const onOpen = vi.fn();
    render(<PipelinesHub projectId="proj-1" onOpen={onOpen} />);
    expect(screen.getByRole("heading", { name: "Enrich companies" })).toBeTruthy();
  });
});

describe("PipelineEditor — canvas editor", () => {
  it("renders the draft graph's nodes on the canvas and deploys the draft", async () => {
    hookState.pipeline = { data: pipelineDetail };
    render(<PipelineEditor pipelineId="pl-1" projectId="proj-1" onBack={vi.fn()} />);

    // The canvas shows the graph's node names.
    expect(await screen.findByText("Company")).toBeTruthy();
    expect(screen.getByText("Normalize")).toBeTruthy();

    // Deploy is offered for a draft; clicking it deploys THIS pipeline.
    const deployBtn = screen.getByRole("button", { name: /deploy version/i });
    await userEvent.click(deployBtn);
    expect(mutations.deploy).toHaveBeenCalledWith("pl-1");

    // No graph mutation was needed to render/deploy (no accidental auto-patch).
    expect(mutations.patchDraft).not.toHaveBeenCalled();
  });
});
