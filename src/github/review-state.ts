import { z } from "zod";
import { reviewReportSchema } from "../review/findings";

const stateMarker = "known-good-review:state";

export const reviewStateSchema = z.object({
  schemaVersion: z.literal(1),
  app: z.literal("known-good-review"),
  pullRequest: z.number().int().positive(),
  initialFullStatus: z.enum([
    "never",
    "debouncing",
    "running",
    "completed",
    "failed",
  ]),
  baseline: z
    .object({
      head: z.string().min(1),
      patchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      findingsArtifactUrl: z.string().url(),
      files: z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)),
      report: reviewReportSchema,
    })
    .nullable(),
  updatedAt: z.string().datetime(),
});

export type ReviewState = z.infer<typeof reviewStateSchema>;

export function encodeReviewState(state: ReviewState): string {
  const json = JSON.stringify(reviewStateSchema.parse(state));
  return `<!-- ${stateMarker}\n${Buffer.from(json).toString("base64url")}\n-->`;
}

export function decodeReviewState(comment: string): ReviewState | null {
  const match = comment.match(
    new RegExp(`<!-- ${stateMarker}\\n([A-Za-z0-9_-]+)\\n-->`),
  );
  if (!match?.[1]) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(match[1], "base64url").toString("utf8"),
    );
    return reviewStateSchema.parse(parsed);
  } catch {
    return null;
  }
}

export function isReviewStateComment(comment: string): boolean {
  return comment.includes(`<!-- ${stateMarker}\n`);
}

export function pendingReviewState(input: {
  readonly pullRequest: number;
  readonly status: "debouncing" | "running" | "failed";
}): ReviewState {
  return {
    schemaVersion: 1,
    app: "known-good-review",
    pullRequest: input.pullRequest,
    initialFullStatus: input.status,
    baseline: null,
    updatedAt: new Date().toISOString(),
  };
}
