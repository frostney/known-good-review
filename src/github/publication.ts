import type { Octokit } from "@octokit/rest";
import { encodeReviewState, type ReviewState } from "./review-state";
import type { TrustedGitHubContext } from "./trusted-context";
import type { ReviewFinding, ReviewReport } from "../review/findings";
import {
  effectivePatchFileFingerprints,
  type PatchFile,
} from "../review/effective-patch";

export const checkName = "known-good-review";
const findingMarkerPrefix = "known-good-review:finding:";

type OctokitClient = Octokit;

function findingMarker(id: string): string {
  return `<!-- ${findingMarkerPrefix}${id} -->`;
}

export function findingBody(finding: ReviewFinding): string {
  const status = finding.status === "open" ? "Open" : finding.status;
  return [
    findingMarker(finding.id),
    `### [${finding.id}] ${finding.title}`,
    "",
    `**${finding.severity} · ${finding.category} · ${status}**`,
    "",
    `Location: \`${finding.location.path}:${finding.location.line}\`${
      finding.location.symbol ? ` (\`${finding.location.symbol}\`)` : ""
    }`,
    "",
    finding.evidence.map((evidence) => `- ${evidence}`).join("\n"),
    "",
    `Impact: ${finding.impact}`,
    "",
    `Smallest remedy: ${finding.remedy}`,
  ].join("\n");
}

function inactiveFindingBody(id: string): string {
  return [
    findingMarker(id),
    `### [${id}] No longer active`,
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
  const counts = new Map<string, number>();
  for (const finding of report.findings) {
    if (finding.status !== "fixed") {
      counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
    }
  }
  const findingSummary = ["BLOCKING", "IMPORTANT", "IMPROVEMENT"]
    .map((severity) => `${severity}: ${counts.get(severity) ?? 0}`)
    .join(" · ");
  return [
    `Verdict: **${report.verdict.replaceAll("_", " ")}**`,
    "",
    findingSummary,
    "",
    `Reviewed ${report.scope.base}…${report.scope.head} with ${report.coverage.activeAxes.join(", ")}.`,
    ...report.limitations.length > 0
      ? ["", "Limitations:", ...report.limitations.map((item) => `- ${item}`)]
      : [],
  ].join("\n");
}

async function upsertCheck(
  octokit: OctokitClient,
  context: TrustedGitHubContext,
  report: ReviewReport,
) {
  const listed = await octokit.rest.checks.listForRef({
    owner: context.owner,
    repo: context.repo,
    ref: context.headSha,
    check_name: checkName,
    per_page: 100,
  });
  const existing = [...listed.data.check_runs]
    .filter((check) => check.name === checkName)
    .sort((left, right) => right.id - left.id)[0];
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

async function reconcileFindingComments(
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
  const existing = new Map(
    comments.flatMap((comment) => {
      const id = markerId(comment.body);
      return id ? [[id, comment] as const] : [];
    }),
  );
  const active = new Set(findings.map((finding) => finding.id));

  for (const finding of findings) {
    const body = findingBody(finding);
    const prior = existing.get(finding.id);
    if (prior) {
      if (prior.body !== body) {
        await octokit.rest.issues.updateComment({
          owner: context.owner,
          repo: context.repo,
          comment_id: prior.id,
          body,
        });
      }
    } else {
      await octokit.rest.issues.createComment({
        owner: context.owner,
        repo: context.repo,
        issue_number: context.pullRequest,
        body,
      });
    }
  }

  for (const [id, prior] of existing) {
    if (!active.has(id)) {
      const body = inactiveFindingBody(id);
      if (prior.body !== body) {
        await octokit.rest.issues.updateComment({
          owner: context.owner,
          repo: context.repo,
          comment_id: prior.id,
          body,
        });
      }
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
  const check = await upsertCheck(input.octokit, input.context, input.report);
  await reconcileFindingComments(
    input.octokit,
    input.context,
    input.report.findings,
  );
  const checkUrl =
    check.html_url ??
    `https://github.com/${input.context.repository}/pull/${input.context.pullRequest}/checks`;
  const changed = await input.octokit.paginate(
    input.octokit.rest.pulls.listFiles,
    {
      owner: input.context.owner,
      repo: input.context.repo,
      pull_number: input.context.pullRequest,
      per_page: 100,
    },
  );
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
    schemaVersion: 1,
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
