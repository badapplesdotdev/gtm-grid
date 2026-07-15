import { pipelineGraphPatchSchema, pipelineGraphSchema, type PipelineGraphPatch } from "@gtmgrid/pipelines";
import { PipelineService } from "@gtmgrid/services";
import { Effect } from "effect";
import { z } from "zod";
import { runWorkerAsMember } from "../_lib";

export const runtime = "nodejs";

const id = z.string().min(1);
const RequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), projectId: id }),
  z.object({ action: z.literal("get"), pipelineId: id }),
  z.object({ action: z.literal("create"), projectId: id, name: z.string().trim().min(1).max(160), description: z.string().max(2_000).nullable().optional(), graph: pipelineGraphSchema.optional() }),
  z.object({ action: z.literal("patch"), pipelineId: id, patches: z.array(pipelineGraphPatchSchema).min(1).max(100) }),
  z.object({ action: z.literal("deploy"), pipelineId: id }),
]);

export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, RequestSchema, (body) => Effect.gen(function* () {
    const service = yield* PipelineService;
    if (body.action === "list") return yield* service.list(body.projectId);
    if (body.action === "get") return yield* service.get(body.pipelineId);
    if (body.action === "create") return yield* service.create(body);
    if (body.action === "patch") return yield* service.patchDraft(body.pipelineId, body.patches as readonly PipelineGraphPatch[]);
    return yield* service.deploy(body.pipelineId);
  }));
}
