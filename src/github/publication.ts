import type { Octokit } from "@octokit/rest";
import { encodeReviewState, type ReviewState } from "./review-state";
import type { TrustedGitHubContext } from "./trusted-context";
import type { ReviewFinding, ReviewReport } from "../review/findings";
import {
  effectivePatchFileFingerprints,
  type PatchFile,
} from "../review/effective-patch";
import {
  findingBody,
  reviewFindingCountSummary,
} from "./review-presentation";

export { findingBody } from "./review-presentation";

export const checkName = "known-good-review";
const findingMarkerPrefix = "known-good-review:finding:";

type OctokitClient = Octokit;

function inactiveFindingBody(id: string): string {
  return [
    `<!-- ${findingMarkerPrefix}${id} -->`,
    "### ✅ No longer active",
    "",
    "The current known-good-review result no longer reports this finding.",
  ].join("\n");
}

function retiredFindingBody(id: string): string {
  return [
    `<!-- known-good-review:retired-finding:${id} -->`,
    "### ↪️ Finding moved",
    "",
    "The current finding is attached to its updated code location.",
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
    /<!-- known-good-review:finding:(CR-[1-9]\d*) -->/,
  );
  return match?.[1] ?? null;
}

function conclusionFor(report: ReviewReport): "failure" | "neutral" | "success" {
  if (report.verdict === "REQUEST_CHANGES") return "failure";
  if (report.verdict === "APPROVE_WITH_IMPROVEMENTS") return "neutral";
  return "success";
}

function checkSummary(report: ReviewReport): string {
  return [
    `Verdict: **${report.verdict.replaceAll("_", " ")}**`,
    "",
    reviewFindingCountSummary(report),
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
) {
  const listed = await octokit.rest.checks.listForRef({
    owner: context.owner,
    repo: context.repo,
    ref: context.headSha,
    check_name: checkName,
    per_page: 100,
  });
  return [...listed.data.check_runs]
    .filter((check) => check.name === checkName)
    .sort((left, right) => right.id - left.id)[0];
}

async function upsertCheck(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  report: ReviewReport,
) {
  const existing = await latestCheck(octokit, context);
  const common = {
    owner: context.owner,
    repo: context.repo,
    name: checkName,
    status: "completed" as const,
    conclusion: conclusionFor(report),
    completed_at: new Date().toISOString(),
    output: {
      title: `known-good-review: ${report.verdict.replaceAll("_", " ")}`,
      summary: checkSummary(report).slice(0, 65_535),
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
  readonly reviewKind: "delta" | "full";
}): Promise<string> {
  const existing = await latestCheck(input.octokit, input.context);
  const common = {
    owner: input.context.owner,
    repo: input.context.repo,
    name: checkName,
    status: "in_progress" as const,
    started_at: new Date().toISOString(),
    output: {
      title: "known-good-review: review in progress",
      summary: `A ${input.reviewKind} review was accepted and is currently running.`,
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
          external_id: `${checkName}:${input.context.pullRequest}:${input.context.headSha}`,
        })
      ).data;
  return (
    check.html_url ??
    `https://github.com/${input.context.repository}/pull/${input.context.pullRequest}/checks`
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

async function reconcileFindingComments(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  findings: readonly ReviewFinding[],
  files: readonly PullRequestFileForComment[],
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullRequest,
    per_page: 100,
  });
  const existing = new Map(
    comments.flatMap((comment) => {
      const id = markerId(comment.body);
      return id ? [[id, comment] as const] : [];
    }),
  );
  const active = new Set(findings.map((finding) => finding.id));

  for (const finding of findings) {
    const location = reviewCommentLocation(finding, files);
    const body = findingBody(finding, location.subjectType);
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
        await octokit.rest.pulls.updateReviewComment({
          owner: context.owner,
          repo: context.repo,
          comment_id: prior.id,
          body: retiredFindingBody(finding.id),
        });
      }
      await octokit.rest.pulls.createReviewComment({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullRequest,
        commit_id: context.headSha,
        path: finding.location.path,
        body,
        ...(location.subjectType === "line"
          ? {
              line: location.line,
              side: location.side,
              subject_type: "line" as const,
            }
          : { subject_type: "file" as const }),
      });
    }
  }

  for (const [id, prior] of existing) {
    if (!active.has(id)) {
      const body = inactiveFindingBody(id);
      if (prior.body !== body) {
        await octokit.rest.pulls.updateReviewComment({
          owner: context.owner,
          repo: context.repo,
          comment_id: prior.id,
          body,
        });
      }
    }
  }
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
  readonly context: TrustedGitHubContext;
  readonly octokit: OctokitClient;
  readonly report: ReviewReport;
}): Promise<{ readonly checkUrl: string; readonly findingCount: number }> {
  if (input.report.scope.head !== input.context.headSha) {
    throw new Error(
      `Refusing to publish report for ${input.report.scope.head}; trusted head is ${input.context.headSha}`,
    );
  }
  const changed = await input.octokit.paginate(
    input.octokit.rest.pulls.listFiles,
    {
      owner: input.context.owner,
      repo: input.context.repo,
      pull_number: input.context.pullRequest,
      per_page: 100,
    },
  );
  await reconcileFindingComments(
    input.octokit,
    input.context,
    input.report.findings,
    changed,
  );
  await retireTimelineFindingComments(
    input.octokit,
    input.context,
    input.report.findings,
  );
  const check = await upsertCheck(input.octokit, input.context, input.report);
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
  return { checkUrl, findingCount: input.report.findings.length };
}

export async function publishFailClosedCheck(input: {
  readonly context: Omit<TrustedGitHubContext, "patchFingerprint">;
  readonly message: string;
  readonly octokit: OctokitClient;
}): Promise<string> {
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
  const check = await upsertCheck(input.octokit, input.context, report);
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
