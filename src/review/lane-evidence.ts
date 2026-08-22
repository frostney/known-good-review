import { readCapabilityPreflight } from "./capability-preflight";
import {
  readNextReviewEvidencePacket,
  type ReviewEvidenceSandbox,
  type ReviewEvidenceManifest,
} from "./evidence-bundle";
import type { ReviewAxis } from "./axes";

export async function readLaneReviewEvidencePacket(
  sandbox: ReviewEvidenceSandbox,
  manifest: ReviewEvidenceManifest,
  axis: ReviewAxis,
  sessionId: string,
) {
  const capabilityPreflight = await readCapabilityPreflight(sandbox, manifest);
  const packet = await readNextReviewEvidencePacket(
    sandbox,
    manifest,
    axis,
    sessionId,
  );
  return { capabilityPreflight, ...packet };
}
