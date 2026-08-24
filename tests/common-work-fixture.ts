import {
  commonReviewWorkSchema,
  commonWorkRecord,
} from "../src/review/common-work";

export function commonWorkFixture(identity: {
  readonly baseSha: string;
  readonly headSha: string;
  readonly patchFingerprint: string;
  readonly repositoryId: string;
}) {
  const historyOutput = {
    baseSha: identity.baseSha,
    paths: [] as string[],
    commitShas: [] as string[],
    truncated: false,
  };
  const history = commonWorkRecord({
    kind: "repository-history",
    identity,
    output: historyOutput,
  });
  const memoryOutput = {
    kind: "unavailable" as const,
    reason: "Repository memory is not configured.",
  };
  const memory = commonWorkRecord({
    kind: "repository-memory",
    identity,
    output: memoryOutput,
    outcome: "unavailable",
  });
  const required = [
    "patch-manifest",
    "capability-preflight",
    "github-evidence",
    "common-probe",
  ] as const;
  return commonReviewWorkSchema.parse({
    executionRevision: "review-common-work-v1",
    records: [
      ...required.map((kind) =>
        commonWorkRecord({ kind, identity, output: [] }),
      ),
      history,
      memory,
    ],
    history: { workId: history.id, ...historyOutput },
    memory: {
      workId: memory.id,
      query: "Prior review findings relevant to these exact changed repository paths: ",
      availability: memoryOutput,
    },
  });
}
