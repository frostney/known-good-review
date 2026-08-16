import { z } from "zod";
import type { SessionAuthContext } from "eve/context";
import { routingAttribute } from "../models/routing";

export const reviewContextAttributes = {
  baseSha: "known_good_review_base_sha",
  event: "known_good_review_event",
  headSha: "known_good_review_head_sha",
  patchFingerprint: "known_good_review_patch_fingerprint",
  plan: "known_good_review_plan",
} as const;

const trustedGitHubContextSchema = z.object({
  installationId: z.coerce.number().int().positive(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullRequest: z.coerce.number().int().positive(),
  repository: z.string().regex(/^[^/]+\/[^/]+$/),
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  patchFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export type TrustedGitHubContext = z.infer<typeof trustedGitHubContextSchema>;

export function withTrustedReviewContext(
  auth: SessionAuthContext,
  values: {
    readonly baseSha: string;
    readonly configSource: string;
    readonly event: string;
    readonly headSha: string;
    readonly patchFingerprint?: string;
    readonly plan: string;
  },
): SessionAuthContext {
  return {
    ...auth,
    attributes: {
      ...auth.attributes,
      [routingAttribute]: values.configSource,
      [reviewContextAttributes.baseSha]: values.baseSha,
      [reviewContextAttributes.event]: values.event,
      [reviewContextAttributes.headSha]: values.headSha,
      [reviewContextAttributes.plan]: values.plan,
      ...(values.patchFingerprint
        ? {
            [reviewContextAttributes.patchFingerprint]:
              values.patchFingerprint,
          }
        : {}),
    },
  };
}

export function trustedGitHubContext(
  auth: SessionAuthContext | null | undefined,
): TrustedGitHubContext {
  if (!auth) {
    throw new Error("GitHub review tools require authenticated channel context");
  }
  const repository = auth.attributes.repository;
  if (typeof repository !== "string") {
    throw new Error("GitHub review context is missing repository identity");
  }
  const [owner, repo] = repository.split("/");
  return trustedGitHubContextSchema.parse({
    installationId: auth.attributes.installation_id,
    owner,
    repo,
    pullRequest: auth.attributes.pull_request_number,
    repository,
    baseSha: auth.attributes[reviewContextAttributes.baseSha],
    headSha: auth.attributes[reviewContextAttributes.headSha],
    patchFingerprint:
      auth.attributes[reviewContextAttributes.patchFingerprint],
  });
}
