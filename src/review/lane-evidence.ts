import { readCapabilityPreflight } from "./capability-preflight";
import {
  readNextReviewEvidencePacket,
  type ReviewEvidenceSandbox,
  type ReviewEvidenceManifest,
} from "./evidence-bundle";
import type { ReviewAxis } from "./axes";
import { readLaneCheckpoint, validateLaneCheckpointCoverage } from "./lane-checkpoint";
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
  const checkpoint = await readLaneCheckpoint(
    sandbox,
    {
      baseSha: identity.baseSha,
      headSha: identity.headSha,
      patchFingerprint: identity.patchFingerprint,
      evidenceDigest: ledger.digest,
    },
    axis,
  );
  if (checkpoint) {
    validateLaneCheckpointCoverage(checkpoint, manifest.entries.length);
  }
  const packet = await readNextReviewEvidencePacket(
    sandbox,
    manifest,
    axis,
    sessionId,
    checkpoint?.revision ?? 0,
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
