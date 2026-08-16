import { connectGitHubCredentials } from "@vercel/connect/eve";
import {
  defaultGitHubAuth,
  GitHubApiError,
  githubChannel,
  type GitHubComment,
  type GitHubInboundContext,
  type GitHubPullRequestEvent,
} from "eve/channels/github";
import { z } from "zod";
import { parseReviewConfig } from "../../src/config/review-config";
import { githubAdapter, githubConnector } from "../../src/github/chat-adapter";
import {
  parsePullRequestFiles,
  planDispatch,
  pullRequestDetailsSchema,
  reviewStateFromComments,
} from "../../src/github/inbound";
import {
  canRequestManualFull,
  requestsManualFullReview,
} from "../../src/github/manual-full";
import {
  publishFailClosedCheck,
  publishReview,
  writeReviewState,
} from "../../src/github/publication";
import { pendingReviewState } from "../../src/github/review-state";
import { withTrustedReviewContext } from "../../src/github/trusted-context";
import { findingsToRevalidate } from "../../src/review/revalidation";

const supportedActions = new Set([
  "closed",
  "converted_to_draft",
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
]);

const contentSchema = z.object({
  content: z.string(),
  encoding: z.literal("base64"),
});

const permissionSchema = z.object({ permission: z.string() });

async function fetchPullRequest(ctx: GitHubInboundContext, number: number) {
  const response = await ctx.github.request({
    method: "GET",
    path: `/repos/${ctx.repository.owner}/${ctx.repository.name}/pulls/${number}`,
  });
  return pullRequestDetailsSchema.parse(response.body);
}

async function fetchAllPages(
  ctx: GitHubInboundContext,
  path: string,
): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await ctx.github.request({
      method: "GET",
      path: `${path}${separator}per_page=100&page=${page}`,
    });
    const items = z.array(z.unknown()).parse(response.body);
    all.push(...items);
    if (items.length < 100) return all;
  }
  throw new Error(`GitHub pagination exceeded the bounded 2,000 item limit for ${path}`);
}

async function fetchTrustedConfig(
  ctx: GitHubInboundContext,
  baseSha: string,
): Promise<string> {
  try {
    const response = await ctx.github.request({
      method: "GET",
      path: `/repos/${ctx.repository.owner}/${ctx.repository.name}/contents/.github/known-good-review.yml?ref=${encodeURIComponent(baseSha)}`,
    });
    const file = contentSchema.parse(response.body);
    return Buffer.from(file.content.replaceAll("\n", ""), "base64").toString(
      "utf8",
    );
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return "";
    throw error;
  }
}

async function fetchReviewState(
  ctx: GitHubInboundContext,
  pullRequest: number,
) {
  const comments = await fetchAllPages(
    ctx,
    `/repos/${ctx.repository.owner}/${ctx.repository.name}/issues/${pullRequest}/comments`,
  );
  return reviewStateFromComments(comments);
}

async function fetchPatchFiles(
  ctx: GitHubInboundContext,
  pullRequest: number,
) {
  return parsePullRequestFiles(
    await fetchAllPages(
      ctx,
      `/repos/${ctx.repository.owner}/${ctx.repository.name}/pulls/${pullRequest}/files`,
    ),
  );
}

function publicationContext(
  ctx: GitHubInboundContext,
  pullRequest: number,
  baseSha: string,
  headSha: string,
  patchFingerprint?: string,
) {
  const installationId = ctx.github.installationId;
  if (!installationId) {
    throw new Error("GitHub webhook did not include an installation id");
  }
  return {
    installationId,
    owner: ctx.repository.owner,
    repo: ctx.repository.name,
    repository: ctx.repository.fullName,
    pullRequest,
    baseSha,
    headSha,
    patchFingerprint,
  };
}

async function dispatchReview(input: {
  readonly action:
    | "closed"
    | "converted_to_draft"
    | "opened"
    | "ready_for_review"
    | "reopened"
    | "synchronize";
  readonly ctx: GitHubInboundContext;
  readonly manualFull?: boolean;
  readonly manualFullAuthorized?: boolean;
}) {
  const pullRequestNumber = input.ctx.conversation.pullRequestNumber;
  if (!pullRequestNumber) return null;
  const pullRequest = await fetchPullRequest(input.ctx, pullRequestNumber);

  if (input.action === "opened" && pullRequest.draft) return null;

  if (input.action === "closed" || pullRequest.draft) {
    const plan = input.action === "closed" ? "cleanup" : "cancel";
    const auth = withTrustedReviewContext(defaultGitHubAuth(input.ctx), {
      baseSha: pullRequest.base.sha,
      configSource: "",
      event: input.action,
      headSha: pullRequest.head.sha,
      plan,
    });
    return {
      auth,
      title: `${plan} ${input.ctx.repository.fullName}#${pullRequestNumber}`,
      context: [
        `<known-good-review-dispatch>${JSON.stringify({
          operation: plan,
          reason:
            plan === "cleanup" ? "pull request closed or merged" : "pull request is draft",
        })}</known-good-review-dispatch>`,
      ],
    };
  }

  const [configSource, state, patchFiles] = await Promise.all([
    fetchTrustedConfig(input.ctx, pullRequest.base.sha),
    fetchReviewState(input.ctx, pullRequestNumber),
    fetchPatchFiles(input.ctx, pullRequestNumber),
  ]);
  const contextWithoutPatch = publicationContext(
    input.ctx,
    pullRequestNumber,
    pullRequest.base.sha,
    pullRequest.head.sha,
  );
  try {
    parseReviewConfig(configSource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await publishFailClosedCheck({
      context: contextWithoutPatch,
      message,
      octokit: githubAdapter(contextWithoutPatch.installationId).octokit,
    });
    return null;
  }

  const dispatch = planDispatch({
    action: input.action,
    draft: pullRequest.draft,
    head: pullRequest.head.sha,
    manualFull: input.manualFull,
    manualFullAuthorized: input.manualFullAuthorized,
    patchFiles,
    state,
  });
  const context = publicationContext(
    input.ctx,
    pullRequestNumber,
    pullRequest.base.sha,
    pullRequest.head.sha,
    dispatch.patchFingerprint,
  );
  const octokit = githubAdapter(context.installationId).octokit;

  if (dispatch.plan.kind === "fail-closed") {
    await publishFailClosedCheck({
      context,
      message:
        dispatch.plan.reason === "lost-baseline"
          ? "The prior review baseline is missing or invalid. An authorized write, maintain, or admin user must request a manual full review."
          : "The manual full review request was not authorized.",
      octokit,
    });
    return null;
  }
  if (dispatch.plan.kind === "reuse") {
    if (!dispatch.priorReport || !dispatch.patchFingerprint) {
      await publishFailClosedCheck({
        context,
        message: "Semantic reuse was selected without a valid prior findings artifact.",
        octokit,
      });
      return null;
    }
    await publishReview({
      context,
      octokit,
      report: {
        ...dispatch.priorReport,
        generatedAt: new Date().toISOString(),
        scope: {
          ...dispatch.priorReport.scope,
          base: pullRequest.base.sha,
          head: pullRequest.head.sha,
        },
        limitations: [
          ...dispatch.priorReport.limitations,
          "Evidence reused after a merge or rebase changed commit identity without changing the effective pull-request patch.",
        ],
      },
    });
    return null;
  }

  if (dispatch.plan.kind === "full" && dispatch.plan.reason === "initial") {
    await writeReviewState(
      octokit,
      context,
      pendingReviewState({
        pullRequest: pullRequestNumber,
        status: dispatch.plan.delaySeconds === 600 ? "debouncing" : "running",
      }),
    );
  }

  const envelope = {
    operation: dispatch.plan.kind,
    plan: dispatch.plan,
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
    patchFingerprint: dispatch.patchFingerprint,
    exactFiles:
      dispatch.plan.kind === "delta" ? dispatch.changedFiles : undefined,
    priorFindings:
      dispatch.plan.kind === "delta" && dispatch.priorReport
        ? {
            ...dispatch.priorReport,
            findings: findingsToRevalidate(
              dispatch.priorReport.findings,
              new Set(dispatch.changedFiles),
            ),
          }
        : undefined,
    carryForwardFindings:
      dispatch.plan.kind === "delta" && dispatch.priorReport
        ? dispatch.priorReport.findings.filter(
            (finding) =>
              !findingsToRevalidate(
                dispatch.priorReport?.findings ?? [],
                new Set(dispatch.changedFiles),
              ).some((selected) => selected.id === finding.id),
          )
        : undefined,
  };
  const auth = withTrustedReviewContext(defaultGitHubAuth(input.ctx), {
    baseSha: pullRequest.base.sha,
    configSource,
    event: input.action,
    headSha: pullRequest.head.sha,
    patchFingerprint: dispatch.patchFingerprint,
    plan: JSON.stringify(dispatch.plan),
  });
  return {
    auth,
    title: `${dispatch.plan.kind} review ${input.ctx.repository.fullName}#${pullRequestNumber}`,
    context: [
      `<known-good-review-dispatch>${JSON.stringify(envelope)}</known-good-review-dispatch>`,
    ],
  };
}

async function onPullRequest(
  ctx: GitHubInboundContext,
  pullRequest: GitHubPullRequestEvent,
) {
  if (!supportedActions.has(pullRequest.action)) return null;
  return dispatchReview({
    action: pullRequest.action as Parameters<typeof dispatchReview>[0]["action"],
    ctx,
  });
}

async function onComment(ctx: GitHubInboundContext, comment: GitHubComment) {
  if (
    ctx.conversation.kind !== "pull_request" ||
    !requestsManualFullReview(comment.body)
  ) {
    return null;
  }
  const permissionResponse = await ctx.github.request({
    method: "GET",
    path: `/repos/${ctx.repository.owner}/${ctx.repository.name}/collaborators/${encodeURIComponent(ctx.sender.login)}/permission`,
  });
  const authorized = canRequestManualFull(
    permissionSchema.parse(permissionResponse.body).permission,
  );
  if (!authorized) {
    await ctx.thread.post(
      "A manual full review requires write, maintain, or admin repository permission.",
    );
    return null;
  }
  return dispatchReview({
    action: "synchronize",
    ctx,
    manualFull: true,
    manualFullAuthorized: true,
  });
}

export default githubChannel({
  botName: "known-good-review",
  credentials: connectGitHubCredentials(githubConnector),
  turnPolicy: "steer",
  progress: { reactions: false },
  onPullRequest,
  onComment,
  events: {
    // Check Runs and finding comments are the product surface. Suppress the
    // ordinary model reply so one turn cannot create a second review surface.
    "message.completed": () => {},
  },
});
