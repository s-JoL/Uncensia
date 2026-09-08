import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Store } from "../store/store.ts";
import { INTENT_DESCRIPTION } from "./descriptions.ts";

/** Read the same durable queue the UI uses. No scheduling or semantic routing. */
export function generationStatusTool(store: Store, conversationId: string): AgentTool {
  return {
    name: "inspect_generations",
    label: "inspect_generations",
    description: "Inspect actual image/video jobs in this conversation, especially after an interruption or when reconciling completed work. With job_id, return its full request, sources, status and outputs; otherwise list recent attempts, newest first. Follow next_before_job_id to read older pages. A queued/running attempt is not completed; do not resubmit it. This is a snapshot, not a polling loop. Normal generation tools already wait for their own result. Inspect pixels separately before judging visual fidelity.",
    parameters: Type.Object({
      intent: Type.String({ description: INTENT_DESCRIPTION }),
      job_id: Type.Optional(Type.String({ description: "Exact job ID for full details." })),
      before_job_id: Type.Optional(Type.String({ description: "Page cursor returned as next_before_job_id." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 25 })),
    }),
    execute: async (_callId, params) => {
      const { job_id, before_job_id, limit = 25 } = params as { job_id?: string; before_job_id?: string; limit?: number };
      if (job_id && before_job_id) throw new Error("Choose job_id for details or before_job_id for a page, not both.");
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer from 1 to 50.");
      const lookup = (id: string) => {
        const job = store.getJob(id);
        if (!job || job.conversationId !== conversationId) throw new Error(`No job ${id} in this conversation.`);
        return job;
      };
      if (before_job_id) lookup(before_job_id);
      const jobs = job_id ? [lookup(job_id)] : store.listJobs({ conversationId, limit: limit + 1, beforeId: before_job_id });
      const page = jobs.slice(0, limit);
      const result = {
        items: page.map(job => job_id ? job : ({
          id: job.id, status: job.status, op: job.op, modelId: job.modelId,
          createdAt: job.createdAt, promptPreview: String(job.params.prompt ?? "").slice(0, 280),
          sources: job.sources, assets: job.assets, error: job.error,
        })),
        next_before_job_id: !job_id && jobs.length > limit ? page.at(-1)!.id : null,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { structuredContent: result } };
    },
  };
}
