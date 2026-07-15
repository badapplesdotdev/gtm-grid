export const PIPELINE_SCHEMA_VERSION = 1 as const;
export const MAX_PIPELINE_NODES = 200;
export const MAX_PIPELINE_EDGES = 500;

export type PipelineExecutionTarget = "local" | "cloud";
export type PipelineOnError = "abort" | "continue";
export type PipelineNodeType =
  | "input"
  | "tool"
  | "ai"
  | "formula"
  | "http"
  | "code"
  | "condition"
  | "output"
  | "pipeline";

export interface PipelinePosition {
  readonly x: number;
  readonly y: number;
}

interface PipelineNodeBase<T extends PipelineNodeType, C> {
  readonly id: string;
  readonly type: T;
  readonly name: string;
  readonly description?: string;
  readonly position: PipelinePosition;
  readonly config: C;
  readonly onError?: PipelineOnError;
}

export type PipelineInputNode = PipelineNodeBase<
  "input",
  {
    readonly key: string;
    readonly valueType?: "any" | "string" | "number" | "boolean" | "object" | "array";
    readonly required?: boolean;
    readonly sample?: unknown;
  }
>;

export type PipelineToolNode = PipelineNodeBase<
  "tool",
  {
    readonly provider: string;
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly credentialBinding?: string;
  }
>;

export type PipelineAiNode = PipelineNodeBase<
  "ai",
  {
    readonly provider?: string;
    readonly model?: string;
    readonly prompt: string;
    readonly system?: string;
    readonly responseFormat?: "text" | "json";
    readonly credentialBinding?: string;
  }
>;

export type PipelineFormulaNode = PipelineNodeBase<
  "formula",
  { readonly expression: string }
>;

export type PipelineHttpNode = PipelineNodeBase<
  "http",
  {
    readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly credentialBinding?: string;
  }
>;

export type PipelineCodeNode = PipelineNodeBase<
  "code",
  { readonly source: string }
>;

export type PipelineConditionNode = PipelineNodeBase<
  "condition",
  {
    readonly expression: string;
    readonly match?: "all" | "any";
    readonly conditions?: Array<{
      readonly id: string;
      readonly left: string;
      readonly operator: "equals" | "not_equals" | "contains" | "not_contains" | "starts_with" | "ends_with" | "greater_than" | "less_than" | "is_empty" | "is_not_empty";
      readonly right: string;
      readonly valueType: "string" | "number" | "boolean" | "date";
    }>;
  }
>;

export type PipelineOutputNode = PipelineNodeBase<
  "output",
  {
    readonly key: string;
    readonly valueType?: "any" | "string" | "number" | "boolean" | "object" | "array";
  }
>;

export type PipelineSubpipelineNode = PipelineNodeBase<
  "pipeline",
  {
    readonly pipelineId: string;
    readonly versionId: string;
    readonly inputMapping: Readonly<Record<string, unknown>>;
  }
>;

export type PipelineNode =
  | PipelineInputNode
  | PipelineToolNode
  | PipelineAiNode
  | PipelineFormulaNode
  | PipelineHttpNode
  | PipelineCodeNode
  | PipelineConditionNode
  | PipelineOutputNode
  | PipelineSubpipelineNode;

export interface PipelineEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** Conditions use `true` and `false`; other nodes normally use `default`. */
  readonly sourcePort?: string;
  readonly targetPort?: string;
}

export interface PipelineGraph {
  readonly schemaVersion: typeof PIPELINE_SCHEMA_VERSION;
  readonly nodes: readonly PipelineNode[];
  readonly edges: readonly PipelineEdge[];
}

export interface PipelineCapabilities {
  readonly local: boolean;
  readonly cloud: boolean;
  readonly reasons: readonly string[];
}

export interface PipelineActionEstimate {
  readonly minimumPerRecord: number;
  readonly expectedPerRecord: number;
  readonly maximumPerRecord: number;
  readonly billableNodeIds: readonly string[];
}

export interface CompiledPipeline {
  readonly graph: PipelineGraph;
  readonly graphHash: string;
  readonly topologicalNodeIds: readonly string[];
  readonly inbound: ReadonlyMap<string, readonly PipelineEdge[]>;
  readonly outbound: ReadonlyMap<string, readonly PipelineEdge[]>;
  readonly capabilities: PipelineCapabilities;
  readonly actionEstimate: PipelineActionEstimate;
}

export type PipelineNodeRunStatus =
  | "succeeded"
  | "failed"
  | "skipped";

export interface PipelineNodeTrace {
  readonly nodeId: string;
  readonly status: PipelineNodeRunStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: string;
  readonly actionConsumed: boolean;
}

export interface PipelineNodeProgress {
  readonly nodeId: string;
  readonly status: "running" | PipelineNodeRunStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: string;
  readonly actionConsumed: boolean;
}

export interface PipelineRunResult {
  readonly status: "succeeded" | "failed";
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly traces: readonly PipelineNodeTrace[];
  readonly actionsConsumed: number;
  readonly firstError?: string;
}

export interface PipelineNodeExecutionContext {
  readonly runId: string;
  readonly rowId: string;
  readonly target: PipelineExecutionTarget;
  readonly node: PipelineNode;
  readonly rootInput: Readonly<Record<string, unknown>>;
  readonly upstream: Readonly<Record<string, unknown>>;
  readonly previousOutputs: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface PipelineNodeExecutionResult {
  readonly output?: unknown;
  /** Required for a condition node. */
  readonly branch?: "true" | "false";
}

export interface PipelineNodeExecutor {
  execute(
    context: PipelineNodeExecutionContext,
  ): Promise<PipelineNodeExecutionResult>;
}

export interface PipelineActionReceipt {
  readonly key: string;
  readonly runId: string;
  readonly rowId: string;
  readonly nodeId: string;
}

export interface PipelineActionSink {
  /** Must be idempotent for `receipt.key`; returns true only on first consume. */
  consume(receipt: PipelineActionReceipt): Promise<boolean>;
}

export interface PipelineRunOptions {
  readonly runId: string;
  readonly rowId: string;
  readonly target: PipelineExecutionTarget;
  readonly input: Readonly<Record<string, unknown>>;
  readonly executor: PipelineNodeExecutor;
  readonly actionSink?: PipelineActionSink;
  readonly onNodeProgress?: (progress: PipelineNodeProgress) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}
