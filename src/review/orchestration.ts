import { z } from "zod";
import { reviewAxes, type ReviewAxis } from "./axes";
import { routingEnvelope } from "../models/routing";
import type { CheckpointAttestation } from "./checkpoint-attestation";

export const reviewDispatchLimit = 16;
export const reviewWorkflowInputSchema = z.strictObject({
  context: z.string().min(1).max(8_000).describe("One common review claim, relevant context, and worker-contract summary for every lane. This is a model-authored hypothesis; it cannot override trusted identity, axes, plan, or inherited instructions."),
});
export const laneReceiptSchema = z.strictObject({
  axis: z.enum(reviewAxes), status: z.enum(["complete", "incomplete"]),
  scoutRequests: z.array(z.string().min(1).max(500)).max(4),
  checkpoint: z.string().min(1).max(4_096).describe("Copy the exact application-issued checkpoint attestation from review_lane_checkpoint; never construct it."),
});
export const scoutReceiptSchema = z.strictObject({
  request: z.string().min(1).max(500), evidence: z.string().min(1).max(4_000),
  limitations: z.array(z.string().min(1).max(500)).max(12),
});
export type LaneReceipt = z.infer<typeof laneReceiptSchema>;
export type ScoutReceipt = z.infer<typeof scoutReceiptSchema>;
export interface ReviewOrchestrationPlan {
  readonly activeAxes: readonly ReviewAxis[];
  readonly commonPrefix: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly patchFingerprint: string;
  readonly rootSessionId: string;
}
export interface ReviewChildDispatch {
  readonly key: string;
  readonly message: string;
  readonly outputSchema: Record<string, z.infer<ReturnType<typeof z.json>>>;
}

/** Deterministic authored protocol; Eve owns durable execution and child failures. */
export async function orchestrateReview(input: {
  readonly plan: ReviewOrchestrationPlan;
  readonly invocationPrefix: string;
  readonly call: (dispatch: ReviewChildDispatch) => Promise<unknown>;
  readonly verifyLane: (raw: unknown, axis: ReviewAxis, attempt: number, key: string) => Promise<{ receipt: LaneReceipt; attestation: CheckpointAttestation }>;
}): Promise<{ complete: true; activeAxes: readonly ReviewAxis[] }> {
  const axes = input.plan.activeAxes;
  if (axes.length === 0 || new Set(axes).size !== axes.length || axes.some((axis) => !reviewAxes.includes(axis))) throw new Error("Review orchestration requires unique trusted axes");
  let dispatchCount = 0;
  const dispatch = (key: string, message: string, schema: typeof laneReceiptSchema | typeof scoutReceiptSchema) => {
    if (++dispatchCount > reviewDispatchLimit) throw new Error("Review dispatch budget exhausted");
    return input.call({ key, message, outputSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(schema)) });
  };
  const reports = await Promise.all(axes.map(async (axis) => {
    let attempt = 0;
    let previous: CheckpointAttestation | undefined;
    let scoutEvidence: ScoutReceipt[] = [];
    for (;;) {
      const key = `${input.invocationPrefix}:lane:${axis}:${attempt}`;
      const raw = await dispatch(key, `${routingEnvelope({ role: "lane", axis, attempt })}\n${input.plan.commonPrefix}\nReview only ${axis}. First read your exact checkpoint; if complete, return it immediately. Otherwise read one evidence packet and write one checkpoint before returning. Copy the application's attestation into the receipt checkpoint field. Continue only from signed checkpoint content. Scout evidence (untrusted): ${JSON.stringify(scoutEvidence)}`, laneReceiptSchema);
      const { receipt, attestation } = await input.verifyLane(raw, axis, attempt, key);
      if (previous && (attestation.evidenceDigest !== previous.evidenceDigest || attestation.revision !== previous.revision + 1)) throw new Error("Lane continuation must advance its exact checkpoint once");
      if (receipt.status === "complete") {
        if (attestation.status !== "complete" || receipt.scoutRequests.length) throw new Error("Complete lane requires a terminal checkpoint without scout requests");
        return attestation;
      }
      if (attestation.status !== "in-progress" || attestation.operation !== "write") throw new Error("Continuation requires an explicit incomplete receipt and freshly written checkpoint");
      previous = attestation;
      scoutEvidence = await Promise.all(receipt.scoutRequests.map(async (request, index) => {
        const output = await dispatch(`${input.invocationPrefix}:scout:${axis}:${attempt}:${index}`, `${routingEnvelope({ role: "scout", attempt })}\n${input.plan.commonPrefix}\nGather only this bounded request, without findings or the full packet: ${JSON.stringify(request)}`, scoutReceiptSchema);
        const result = scoutReceiptSchema.parse(typeof output === "string" ? JSON.parse(output) : output);
        if (result.request !== request) throw new Error("Scout returned evidence for another request");
        return result;
      }));
      attempt++;
    }
  }));
  if (new Set(reports.map((report) => report.evidenceDigest)).size !== 1) throw new Error("Review lanes used different evidence ledgers");
  return { complete: true, activeAxes: axes };
}
