import type { Octokit } from "@octokit/rest";
import type { ReviewConfig } from "../config/review-config";
import { encodeReviewState, type ReviewState } from "./review-state";
import type { TrustedGitHubContext } from "./trusted-context";
import type { ReviewFinding, ReviewReport } from "../review/findings";
import {
  effectivePatchFileFingerprints,
  type PatchFile,
} from "../review/effective-patch";
import {
  findingBody,
  publishedFindings,
  reviewFindingCountSummary,
} from "./review-presentation";
import {
  validateCommenterPresentation,
  type CommenterFindingPresentation,
  type CommenterPresentation,
} from "./commenter-presentation";
import { reviewAxes, type ReviewAxis } from "../review/axes";

export { findingBody } from "./review-presentation";

export const checkName = "known-good-review";
export function axisCheckName(axis: ReviewAxis): string {
  return `${checkName} / ${axis}`;
}
const findingMarkerPrefix = "known-good-review:finding:";

export type ActiveReviewIdentity =
  | { readonly kind: "delta" }
  | { readonly kind: "full"; readonly reason: "initial" | "manual" };

export function activeReviewExternalId(
  context: Pick<TrustedGitHubContext, "baseSha" | "headSha" | "pullRequest">,
  review: ActiveReviewIdentity,
): string {
  return [
    checkName,
    context.pullRequest,
    context.baseSha,
    context.headSha,
    review.kind,
    review.kind === "full" ? review.reason : "none",
  ].join(":");
}

export function parseActiveReviewExternalId(
  externalId: string | null | undefined,
  expected: Pick<
    TrustedGitHubContext,
    "baseSha" | "headSha" | "pullRequest"
  >,
): ActiveReviewIdentity | null {
  if (!externalId) return null;
  const [name, pullRequest, baseSha, headSha, kind, reason, extra] =
    externalId.split(":");
  if (
    extra !== undefined ||
    name !== checkName ||
    pullRequest !== String(expected.pullRequest) ||
    baseSha !== expected.baseSha ||
    headSha !== expected.headSha
  ) {
    return null;
  }
  if (kind === "delta" && reason === "none") return { kind };
  if (kind === "full" && (reason === "initial" || reason === "manual")) {
    return { kind, reason };
  }
  return null;
}

const addReviewThreadMutation = `
  mutation KnownGoodReviewAddReviewThread(
    $input: AddPullRequestReviewThreadInput!
  ) {
    addPullRequestReviewThread(input: $input) {
      thread {
        id
      }
    }
  }
`;

const reviewThreadsQuery = `
  query KnownGoodReviewThreads(
    $owner: String!
    $repo: String!
    $number: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                databaseId
                body
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }
`;

const resolveReviewThreadMutation = `
  mutation KnownGoodReviewResolveThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

type OctokitClient = Octokit;

function resolutionReplyBody(
  id: string,
  headSha: string,
  reason: "fixed" | "moved" | "not-published",
): string {
  const message = reason === "fixed"
    ? "✅ Fixed in the current review."
    : reason === "moved"
      ? "↪️ This finding moved to a new inline location in the current review."
      : "✅ This finding is no longer published by the current review profile.";
  return [
    `<!-- known-good-review:resolution:${id}:${headSha}:${reason} -->`,
    message,
  ].join("\n");
}

function retiredTimelineFindingBody(id: string): string {
  return [
    `<!-- known-good-review:retired-finding:${id} -->`,
    "### ↪️ Finding moved inline",
    "",
    "The finding is now available as an inline review thread on the changed file.",
  ].join("\n");
}

function inactiveTimelineFindingBody(id: string): string {
  return [
    `<!-- known-good-review:retired-finding:${id} -->`,
    "### ✅ No longer active",
    "",
    "The current known-good-review result no longer reports this finding.",
  ].join("\n");
}

function markerId(body: string | null | undefined): string | null {
  const match = body?.match(
    /<!-- known-good-review:(?:finding|retired-finding):(CR-[1-9]\d*) -->/,
  );
  return match?.[1] ?? null;
}

function hasBlockingFinding(report: ReviewReport): boolean {
  return report.findings.some(
    (finding) =>
      finding.status !== "fixed" &&
      (finding.severity === "BLOCKING" || finding.severity === "IMPORTANT"),
  );
}

function conclusionFor(
  report: ReviewReport,
  config: Pick<ReviewConfig, "blocking">,
): "failure" | "neutral" | "success" {
  if (config.blocking && hasBlockingFinding(report)) return "failure";
  if (report.findings.some((finding) => finding.status !== "fixed")) return "neutral";
  return "success";
}

function checkSummary(
  report: ReviewReport,
  config: Pick<ReviewConfig, "blocking" | "profile">,
): string {
  const published = publishedFindings(report, config.profile);
  const active = report.findings.filter((finding) => finding.status !== "fixed");
  return [
    `Policy result: **${config.blocking && hasBlockingFinding(report) ? "CHANGES REQUESTED" : "REVIEW COMPLETE"}**`,
    "",
    reviewFindingCountSummary(report, config.profile),
    `Published inline: **${published.length} of ${active.length} active findings**`,
    "",
    `Reviewed ${report.scope.base}…${report.scope.head} with ${report.coverage.activeAxes.join(", ")}.`,
    ...report.limitations.length > 0
      ? ["", "Limitations:", ...report.limitations.map((item) => `- ${item}`)]
      : [],
  ].join("\n");
}

async function latestCheck(
  octokit: OctokitClient,
  context: Omit<TrustedGitHubContext, "patchFingerprint">,
  name = checkName,
) {
  const listed = await octokit.rest.checks.listForRef({
    owner: context.owner,
    repo: context.repo,
    ref: context.headSha,
    check_name: name,
    per_page: 100,
  });
  return [...listed.data.check_runs]
    .filter((check) => check.name === name)
    .sort((left, right) => right.id - left.id)[0];
}

async function upsertCheck(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  report: ReviewReport,
  config: Pick<ReviewConfig, "blocking" | "profile">,
  forcedConclusion?: "action_required",
) {
  const existing = await latestCheck(octokit, context);
  const common = {
    owner: context.owner,
    repo: context.repo,
    name: checkName,
    status: "completed" as const,
    conclusion: forcedConclusion ?? conclusionFor(report, config),
    completed_at: new Date().toISOString(),
    output: {
      title: forcedConclusion === "action_required"
        ? "known-good-review: review incomplete"
        : config.blocking && hasBlockingFinding(report)
        ? "known-good-review: changes requested"
        : "known-good-review: review complete",
      summary: checkSummary(report, config).slice(0, 65_535),
    },
  };
  if (existing) {
    return (
      await octokit.rest.checks.update({
        ...common,
        check_run_id: existing.id,
      })
    ).data;
  }
  return (
    await octokit.rest.checks.create({
      ...common,
      head_sha: context.headSha,
      external_id: `${checkName}:${context.pullRequest}:${context.headSha}`,
    })
  ).data;
}

export async function publishInProgressCheck(input: {
  readonly context: Omit<TrustedGitHubContext, "patchFingerprint">;
  readonly octokit: OctokitClient;
  readonly review: ActiveReviewIdentity;
  readonly activeAxes?: readonly ReviewAxis[];
  readonly skippedAxes?: readonly ReviewAxis[];
}): Promise<string> {
  const existing = await latestCheck(input.octokit, input.context);
  const common = {
    owner: input.context.owner,
    repo: input.context.repo,
    name: checkName,
    external_id: activeReviewExternalId(input.context, input.review),
    status: "in_progress" as const,
    started_at: new Date().toISOString(),
    output: {
      title: "known-good-review: review in progress",
      summary: `A ${input.review.kind} review was accepted and is currently running.`,
    },
  };
  const check = existing && existing.status !== "completed"
    ? (
        await input.octokit.rest.checks.update({
          ...common,
          check_run_id: existing.id,
        })
      ).data
    : (
        await input.octokit.rest.checks.create({
          ...common,
          head_sha: input.context.headSha,
        })
      ).data;
  await Promise.all([
    ...(input.activeAxes ?? []).map((axis) =>
      upsertAxisCheck({
        axis,
        conclusion: null,
        context: input.context,
        octokit: input.octokit,
        summary: "This review axis is running.",
      }),
    ),
    ...(input.skippedAxes ?? []).map((axis) =>
      upsertAxisCheck({
        axis,
        conclusion: "skipped",
        context: input.context,
        octokit: input.octokit,
        summary: "This conditional review axis does not apply to the current change.",
      }),
    ),
  ]);
  return (
    check.html_url ??
    `https://github.com/${input.context.repository}/pull/${input.context.pullRequest}/checks`
  );
}

async function upsertAxisCheck(input: {
  readonly axis: ReviewAxis;
  readonly conclusion: "action_required" | "skipped" | "success" | null;
  readonly context: Omit<TrustedGitHubContext, "patchFingerprint">;
  readonly octokit: OctokitClient;
  readonly summary: string;
}): Promise<void> {
  const name = axisCheckName(input.axis);
  const existing = await latestCheck(input.octokit, input.context, name);
  const completed = input.conclusion !== null;
  if (existing?.status === "completed" && completed) {
    return;
  }
  const common = {
    owner: input.context.owner,
    repo: input.context.repo,
    name,
    status: completed ? ("completed" as const) : ("in_progress" as const),
    ...(completed
      ? {
          conclusion: input.conclusion,
          completed_at: new Date().toISOString(),
        }
      : { started_at: new Date().toISOString() }),
    output: {
      title: `${input.axis}: ${completed ? input.conclusion?.replaceAll("_", " ") : "in progress"}`,
      summary: input.summary,
    },
  };
  if (existing && existing.status !== "completed") {
    await input.octokit.rest.checks.update({
      ...common,
      check_run_id: existing.id,
    });
    return;
  }
  await input.octokit.rest.checks.create({
    ...common,
    head_sha: input.context.headSha,
    external_id: `${name}:${input.context.pullRequest}:${input.context.headSha}`,
  });
}

export async function publishAxisCheckpoint(input: {
  readonly axis: ReviewAxis;
  readonly context: Omit<TrustedGitHubContext, "patchFingerprint">;
  readonly octokit: OctokitClient;
  readonly status: "complete" | "in-progress";
}): Promise<void> {
  await upsertAxisCheck({
    axis: input.axis,
    conclusion: input.status === "complete" ? "success" : null,
    context: input.context,
    octokit: input.octokit,
    summary:
      input.status === "complete"
        ? "This review axis completed its evidence coverage. Findings are summarized by the aggregate review."
        : "This review axis saved progress and is continuing in a fresh context.",
  });
}

async function completeAxisChecks(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  report: ReviewReport,
): Promise<void> {
  const active = new Set(report.coverage.activeAxes);
  await Promise.all(
    reviewAxes.map((axis) =>
      upsertAxisCheck({
        axis,
        conclusion: active.has(axis) ? "success" : "skipped",
        context,
        octokit,
        summary: active.has(axis)
          ? "This review axis completed its evidence coverage. Findings are summarized by the aggregate review."
          : "This conditional review axis did not run for the current change.",
      }),
    ),
  );
}

interface PullRequestFileForComment {
  readonly filename: string;
  readonly patch?: string;
  readonly status: string;
}

export type ReviewCommentLocation =
  | { readonly subjectType: "file" }
  | {
      readonly line: number;
      readonly side: "LEFT" | "RIGHT";
      readonly subjectType: "line";
    };

function commentableLines(patch: string): {
  readonly left: ReadonlySet<number>;
  readonly right: ReadonlySet<number>;
} {
  const left = new Set<number>();
  const right = new Set<number>();
  let oldLine: number | null = null;
  let newLine: number | null = null;
  for (const patchLine of patch.split("\n")) {
    const header = patchLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header?.[1] && header[2]) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (oldLine === null || newLine === null || patchLine.startsWith("\\")) {
      continue;
    }
    if (patchLine.startsWith("+")) {
      right.add(newLine);
      newLine += 1;
      continue;
    }
    if (patchLine.startsWith("-")) {
      left.add(oldLine);
      oldLine += 1;
      continue;
    }
    left.add(oldLine);
    right.add(newLine);
    oldLine += 1;
    newLine += 1;
  }
  return { left, right };
}

export function reviewCommentLocation(
  finding: ReviewFinding,
  files: readonly PullRequestFileForComment[],
): ReviewCommentLocation {
  const file = files.find(
    (candidate) => candidate.filename === finding.location.path,
  );
  if (!file?.patch) return { subjectType: "file" };
  const lines = commentableLines(file.patch);
  if (file.status === "removed" && lines.left.has(finding.location.line)) {
    return {
      line: finding.location.line,
      side: "LEFT",
      subjectType: "line",
    };
  }
  if (lines.right.has(finding.location.line)) {
    return {
      line: finding.location.line,
      side: "RIGHT",
      subjectType: "line",
    };
  }
  return { subjectType: "file" };
}

function sameCommentLocation(
  existing: {
    readonly line?: number | null;
    readonly path: string;
    readonly side?: string | null;
    readonly subject_type?: string | null;
  },
  finding: ReviewFinding,
  location: ReviewCommentLocation,
): boolean {
  if (existing.path !== finding.location.path) return false;
  if (location.subjectType === "file") return existing.subject_type === "file";
  return existing.line === location.line && existing.side === location.side;
}

interface NewReviewThread {
  readonly body: string;
  readonly finding: ReviewFinding;
  readonly location: ReviewCommentLocation;
}

async function deleteViewerPendingReviews(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
): Promise<void> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullRequest,
    per_page: 100,
  });
  for (const review of reviews) {
    if (review.state !== "PENDING") continue;
    await octokit.rest.pulls.deletePendingReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullRequest,
      review_id: review.id,
    });
  }
}

async function createReviewThreads(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  threads: readonly NewReviewThread[],
  report: ReviewReport,
  config: Pick<ReviewConfig, "blocking" | "profile">,
): Promise<void> {
  if (threads.length === 0 && !config.blocking) return;
  await deleteViewerPendingReviews(octokit, context);
  const created = await octokit.rest.pulls.createReview({
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullRequest,
    commit_id: context.headSha,
  });
  const pullRequestReviewId = created.data.node_id;
  if (!pullRequestReviewId) {
    throw new Error("GitHub did not return the pending review identity");
  }
  try {
    for (const thread of threads) {
      await octokit.graphql(addReviewThreadMutation, {
        input: {
          body: thread.body,
          path: thread.finding.location.path,
          pullRequestReviewId,
          subjectType:
            thread.location.subjectType === "line" ? "LINE" : "FILE",
          ...(thread.location.subjectType === "line"
            ? {
                line: thread.location.line,
                side: thread.location.side,
              }
            : {}),
        },
      });
    }
    const event = config.blocking
      ? hasBlockingFinding(report)
        ? "REQUEST_CHANGES" as const
        : "APPROVE" as const
      : "COMMENT" as const;
    await octokit.rest.pulls.submitReview({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullRequest,
      review_id: created.data.id,
      event,
      ...(event === "APPROVE"
        ? {}
        : { body: checkSummary(report, config).slice(0, 65_535) }),
    });
  } catch (error) {
    try {
      await octokit.rest.pulls.deletePendingReview({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullRequest,
        review_id: created.data.id,
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "GitHub review publication and pending-review cleanup both failed",
      );
    }
    throw error;
  }
}

interface ReviewThreadIdentity {
  readonly commentIds: readonly number[];
  readonly id: string;
  readonly isResolved: boolean;
}

async function reviewThreadIdentities(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
): Promise<ReviewThreadIdentity[]> {
  const threads: ReviewThreadIdentity[] = [];
  let after: string | null = null;
  for (;;) {
    const response: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: Array<{
              id: string;
              isResolved: boolean;
              comments: { nodes: Array<{ databaseId: number | null; body: string }> };
            }>;
            pageInfo: { endCursor: string | null; hasNextPage: boolean };
          };
        };
      };
    } = await octokit.graphql(reviewThreadsQuery, {
      owner: context.owner,
      repo: context.repo,
      number: context.pullRequest,
      after,
    });
    const connection: {
      nodes: Array<{
        id: string;
        isResolved: boolean;
        comments: { nodes: Array<{ databaseId: number | null; body: string }> };
      }>;
      pageInfo: { endCursor: string | null; hasNextPage: boolean };
    } = response.repository.pullRequest.reviewThreads;
    threads.push(
      ...connection.nodes.map((thread) => ({
        id: thread.id,
        isResolved: thread.isResolved,
        commentIds: thread.comments.nodes.flatMap((comment) =>
          comment.databaseId === null ? [] : [comment.databaseId],
        ),
      })),
    );
    if (!connection.pageInfo.hasNextPage) return threads;
    after = connection.pageInfo.endCursor;
    if (!after) throw new Error("GitHub review-thread pagination lost its cursor");
  }
}

async function replyAndResolveFinding(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  comments: readonly { readonly body?: string | null; readonly id: number; readonly in_reply_to_id?: number | null }[],
  roots: readonly { readonly body?: string | null; readonly id: number }[],
  id: string,
  reason: "fixed" | "moved" | "not-published",
  threads: readonly ReviewThreadIdentity[],
): Promise<void> {
  const body = resolutionReplyBody(id, context.headSha, reason);
  const rootIds = new Set(roots.map((root) => root.id));
  const alreadyReplied = comments.some(
    (comment) =>
      comment.in_reply_to_id !== null &&
      comment.in_reply_to_id !== undefined &&
      rootIds.has(comment.in_reply_to_id) &&
      comment.body?.includes(`known-good-review:resolution:${id}:${context.headSha}:${reason}`),
  );
  const target = reason === "fixed" ? roots[0] : roots.at(-1);
  if (target && !alreadyReplied) {
    await octokit.rest.pulls.createReplyForReviewComment({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullRequest,
      comment_id: target.id,
      body,
    });
  }
  for (const thread of threads) {
    if (
      thread.isResolved ||
      !thread.commentIds.some((commentId) => rootIds.has(commentId))
    ) {
      continue;
    }
    await octokit.graphql(resolveReviewThreadMutation, { threadId: thread.id });
  }
}

async function reconcileFindingComments(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  report: ReviewReport,
  config: Pick<ReviewConfig, "blocking" | "profile">,
  presentation: CommenterPresentation | null,
  files: readonly PullRequestFileForComment[],
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullRequest,
    per_page: 100,
  });
  const rootsById = new Map<string, typeof comments>();
  for (const comment of comments) {
    if (comment.in_reply_to_id !== null && comment.in_reply_to_id !== undefined) continue;
    const id = markerId(comment.body);
    if (!id) continue;
    rootsById.set(id, [...(rootsById.get(id) ?? []), comment]);
  }
  const existing = new Map(
    [...rootsById].flatMap(([id, roots]) => {
      const newest = roots.at(-1);
      return newest ? [[id, newest] as const] : [];
    }),
  );
  const findings = publishedFindings(report, config.profile);
  const active = new Set(findings.map((finding) => finding.id));
  const presentationById = new Map(
    presentation?.findings.map((finding) => [finding.id, finding] as const) ?? [],
  );
  const newThreads: NewReviewThread[] = [];

  for (const finding of findings) {
    const location = reviewCommentLocation(finding, files);
    const body = findingBody(
      finding,
      location.subjectType,
      presentationById.get(finding.id),
    );
    const prior = existing.get(finding.id);
    if (prior && sameCommentLocation(prior, finding, location)) {
      if (prior.body !== body) {
        await octokit.rest.pulls.updateReviewComment({
          owner: context.owner,
          repo: context.repo,
          comment_id: prior.id,
          body,
        });
      }
    } else {
      if (prior) {
        const threads = await reviewThreadIdentities(octokit, context);
        await replyAndResolveFinding(
          octokit,
          context,
          comments,
          rootsById.get(finding.id) ?? [],
          finding.id,
          "moved",
          threads,
        );
      }
      newThreads.push({ body, finding, location });
    }
  }

  await createReviewThreads(octokit, context, newThreads, report, config);

  const inactiveIds = [...existing.keys()].filter((id) => !active.has(id));
  const threadIdentities = inactiveIds.length > 0
    ? await reviewThreadIdentities(octokit, context)
    : [];
  const canonicalById = new Map(report.findings.map((finding) => [finding.id, finding]));
  for (const [id] of existing) {
    if (!active.has(id)) {
      const finding = canonicalById.get(id);
      await replyAndResolveFinding(
        octokit,
        context,
        comments,
        rootsById.get(id) ?? [],
        id,
        finding?.status === "fixed" ? "fixed" : "not-published",
        threadIdentities,
      );
    }
  }
}

async function failRunningAxisChecks(
  octokit: OctokitClient,
  context: Omit<TrustedGitHubContext, "patchFingerprint">,
  message: string,
): Promise<void> {
  await Promise.all(
    reviewAxes.map(async (axis) => {
      const existing = await latestCheck(octokit, context, axisCheckName(axis));
      if (!existing || existing.status === "completed") return;
      await octokit.rest.checks.update({
        owner: context.owner,
        repo: context.repo,
        check_run_id: existing.id,
        name: axisCheckName(axis),
        status: "completed",
        conclusion: "action_required",
        completed_at: new Date().toISOString(),
        output: {
          title: `${axis}: incomplete`,
          summary: message,
        },
      });
    }),
  );
}

async function retireTimelineFindingComments(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  findings: readonly ReviewFinding[],
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullRequest,
    per_page: 100,
  });
  const active = new Set(findings.map((finding) => finding.id));
  for (const comment of comments) {
    const id = markerId(comment.body);
    if (!id) continue;
    const body = active.has(id)
      ? retiredTimelineFindingBody(id)
      : inactiveTimelineFindingBody(id);
    if (comment.body !== body) {
      await octokit.rest.issues.updateComment({
        owner: context.owner,
        repo: context.repo,
        comment_id: comment.id,
        body,
      });
    }
  }
}

export async function writeReviewState(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  state: ReviewState,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullRequest,
    per_page: 100,
  });
  const existing = comments.find((comment) =>
    comment.body?.includes("<!-- known-good-review:state\n"),
  );
  const body = encodeReviewState(state);
  if (body.length > 65_000) {
    throw new Error(
      "The v2 findings artifact exceeds GitHub comment storage; the review was not published",
    );
  }
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: context.owner,
      repo: context.repo,
      comment_id: existing.id,
      body,
    });
    return;
  }
  await octokit.rest.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullRequest,
    body,
  });
}

export async function publishReview(input: {
  readonly config?: Pick<ReviewConfig, "blocking" | "profile">;
  readonly context: TrustedGitHubContext;
  readonly octokit: OctokitClient;
  readonly presentation?: CommenterPresentation | null;
  readonly reconcileFindings?: boolean;
  readonly report: ReviewReport;
}): Promise<{ readonly checkUrl: string; readonly findingCount: number }> {
  if (input.report.scope.head !== input.context.headSha) {
    throw new Error(
      `Refusing to publish report for ${input.report.scope.head}; trusted head is ${input.context.headSha}`,
    );
  }
  const config = input.config ?? { blocking: false, profile: "balanced" as const };
  const presentation = input.presentation
    ? validateCommenterPresentation(input.report, input.presentation)
    : null;
  const changed = await input.octokit.paginate(
    input.octokit.rest.pulls.listFiles,
    {
      owner: input.context.owner,
      repo: input.context.repo,
      pull_number: input.context.pullRequest,
      per_page: 100,
    },
  );
  if (input.reconcileFindings ?? true) {
    await reconcileFindingComments(
      input.octokit,
      input.context,
      input.report,
      config,
      presentation,
      changed,
    );
    await retireTimelineFindingComments(
      input.octokit,
      input.context,
      publishedFindings(input.report, config.profile),
    );
  } else if (config.blocking) {
    await createReviewThreads(
      input.octokit,
      input.context,
      [],
      input.report,
      config,
    );
  }
  await completeAxisChecks(input.octokit, input.context, input.report);
  const check = await upsertCheck(
    input.octokit,
    input.context,
    input.report,
    config,
  );
  const checkUrl =
    check.html_url ??
    `https://github.com/${input.context.repository}/pull/${input.context.pullRequest}/checks`;
  const patchFiles: PatchFile[] = changed.map((file) => {
    if (!file.sha) {
      throw new Error(
        `GitHub did not return content identity for ${file.filename}; refusing to advance the review baseline`,
      );
    }
    return {
      blobSha: file.sha,
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status:
        file.status === "removed"
          ? "deleted"
          : file.status === "renamed"
            ? "renamed"
            : file.status === "added"
              ? "added"
              : file.status === "copied"
                ? "copied"
                : "modified",
      patch: file.patch ?? null,
    };
  });
  await writeReviewState(input.octokit, input.context, {
    schemaVersion: 2,
    app: checkName,
    pullRequest: input.context.pullRequest,
    initialFullStatus: "completed",
    publication: config,
    baseline: {
      head: input.context.headSha,
      patchFingerprint:
        input.context.patchFingerprint ??
        (() => {
          throw new Error("Trusted review context is missing patch identity");
        })(),
      findingsArtifactUrl: checkUrl,
      files: effectivePatchFileFingerprints(patchFiles),
      report: input.report,
    },
    updatedAt: new Date().toISOString(),
  });
  return {
    checkUrl,
    findingCount: publishedFindings(input.report, config.profile).length,
  };
}

export async function publishFailClosedCheck(input: {
  readonly context: Omit<TrustedGitHubContext, "patchFingerprint">;
  readonly message: string;
  readonly octokit: OctokitClient;
}): Promise<string> {
  await failRunningAxisChecks(input.octokit, input.context, input.message);
  const existing = await latestCheck(input.octokit, input.context);
  if (existing?.conclusion === "action_required") {
    return (
      existing.html_url ??
      `https://github.com/${input.context.repository}/pull/${input.context.pullRequest}/checks`
    );
  }
  const report: ReviewReport = {
    schemaVersion: 2,
    kind: "code-review",
    generatedAt: new Date().toISOString(),
    verdict: "REQUEST_CHANGES",
    scope: {
      claim: "Review configuration and lifecycle admission",
      base: input.context.baseSha,
      head: input.context.headSha,
      dirtyState: "not inspected",
    },
    coverage: {
      activeAxes: [],
      skippedAxes: [],
      staticOnly: [],
      unreached: ["Review did not start because admission failed closed."],
    },
    churn: { window: "not inspected", symbolCoverage: [], fileFallbacks: [] },
    probes: [],
    findings: [],
    verifiedClaims: [],
    limitations: [input.message],
  };
  const check = await upsertCheck(
    input.octokit,
    input.context,
    report,
    { blocking: true, profile: "balanced" },
    "action_required",
  );
  return (
    check.html_url ??
    `https://github.com/${input.context.repository}/pull/${input.context.pullRequest}/checks`
  );
}

export async function publishBudgetExhaustedCheck(input: {
  readonly context: Omit<TrustedGitHubContext, "patchFingerprint">;
  readonly budgetAxis: "input" | "output";
  readonly reviewAxis: string;
  readonly usedTokens: number;
  readonly limit: number;
  readonly octokit: OctokitClient;
}): Promise<string> {
  await failRunningAxisChecks(
    input.octokit,
    input.context,
    `This review axis did not complete because the ${input.budgetAxis} token budget was exhausted.`,
  );
  const existing = await latestCheck(input.octokit, input.context);
  const common = {
    owner: input.context.owner,
    repo: input.context.repo,
    name: checkName,
    status: "completed" as const,
    conclusion: "action_required" as const,
    completed_at: new Date().toISOString(),
    output: {
      title: "known-good-review: review incomplete",
      summary: [
        "The review stopped without publishing a verdict because its Eve session budget was exhausted.",
        "",
        `Review axis: **${input.reviewAxis}**`,
        `Budget axis: **${input.budgetAxis}**`,
        `Measured usage: **${input.usedTokens.toLocaleString()} tokens**`,
        `Configured cap: **${input.limit.toLocaleString()} tokens**`,
        "",
        "No partial findings were published. Rerun manually only after changing the model, scope, or configured budget.",
      ].join("\n"),
    },
  };
  const check = existing
    ? (
        await input.octokit.rest.checks.update({
          ...common,
          check_run_id: existing.id,
        })
      ).data
    : (
        await input.octokit.rest.checks.create({
          ...common,
          head_sha: input.context.headSha,
          external_id: `${checkName}:${input.context.pullRequest}:${input.context.headSha}`,
        })
      ).data;
  return (
    check.html_url ??
    `https://github.com/${input.context.repository}/pull/${input.context.pullRequest}/checks`
  );
}
