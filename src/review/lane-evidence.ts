import { readCapabilityPreflight } from "./capability-preflight";
import {
  readNextReviewEvidencePacket,
  type ReviewEvidenceSandbox,
  type ReviewEvidenceManifest,
} from "./evidence-bundle";
import type { ReviewAxis } from "./axes";
import {
  readReviewEvidenceLedger,
  validatePreparedArtifactArchives,
  validateReviewEvidenceLedgerComponents,
  type ReviewEvidenceLedgerIdentity,
} from "./evidence-ledger";

export async function readLaneReviewEvidencePacket(
  sandbox: ReviewEvidenceSandbox & {
    readBinaryFile(options: {
      readonly path: string;
    }): PromiseLike<Uint8Array | null>;
  },
  identity: ReviewEvidenceLedgerIdentity,
  manifest: ReviewEvidenceManifest,
  axis: ReviewAxis,
  sessionId: string,
) {
  const ledger = await readReviewEvidenceLedger(sandbox, identity);
  const capabilityPreflight = await readCapabilityPreflight(sandbox, manifest);
  validateReviewEvidenceLedgerComponents(ledger, {
    capabilities: capabilityPreflight,
    manifest,
  });
  await validatePreparedArtifactArchives(sandbox, ledger);
  const packet = await readNextReviewEvidencePacket(
    sandbox,
    manifest,
    axis,
    sessionId,
  );
  return {
    ledgerDigest: ledger.digest,
    commonWork: ledger.commonWork,
    github: ledger.github,
    probes: ledger.probes,
    gaps: ledger.gaps,
    capabilityPreflight,
    ...packet,
  };
}
