import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { githubAdapter } from "../../src/github/chat-adapter";
import {
  readLatestReviewState,
  stageReviewPublication,
} from "../../src/github/publication";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { readLaneCheckpoint } from "../../src/review/lane-checkpoint";
import {
  assembleCanonicalReviewReport,
  reportAssemblyFailure,
} from "../../src/review/report-assembly";
import { advanceReviewRecovery } from "../../src/review/recovery";
import {
  currentRecoveryState,
  reviewRecoveryState,
} from "../lib/review-recovery";
import {
  currentReviewReportState,
  reviewReportState,
} from "../lib/review-report";
import { currentLaneCheckpointIdentity } from "../lib/review-evidence";

export const assembleReviewReportInputSchema = z
  .object({
    draft: z.unknown(),
  })
  .strict();

export default defineTool({
  description:
    "Assemble, validate, and durably stage the canonical v2 report from model-authored review content plus application-owned identity, completed lane checkpoints, recorded revalidation, and the prior baseline. The input excludes report identity, prior findings, finding IDs, verdict, and publication targets.",
  inputSchema: assembleReviewReportInputSchema,
  async execute({ draft }, ctx) {
    if (ctx.session.parent) {
      throw new Error("Only the review coordinator can assemble a report");
    }
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    if (!trusted.patchFingerprint) {
      throw new Error("Trusted review report is missing patch identity");
    }
    const recovery = currentRecoveryState(ctx.session.auth.current);
    const expectedStage =
      recovery.selectedFindingIds.length > 0
        ? "revalidation-complete"
        : "axes-complete";
    if (
      recovery.stage !== expectedStage &&
      recovery.stage !== "report-reconciled"
    ) {
      throw new Error(
        "Canonical report assembly requires completed axes and selected-finding revalidation",
      );
    }
    const sandbox = await ctx.getSandbox();
    const checkpointIdentity = await currentLaneCheckpointIdentity(
      ctx.session.auth.current,
      sandbox,
    );
    for (const axis of recovery.activeAxes) {
      const checkpoint = await readLaneCheckpoint(
        sandbox,
        checkpointIdentity,
        axis,
      );
      if (checkpoint?.status !== "complete") {
        throw new Error(
          "Canonical report assembly requires every exact lane checkpoint",
        );
      }
    }

    const current = currentReviewReportState(ctx.session.auth.current);
    let latest = current;
    const octokit = githubAdapter(trusted.installationId).octokit;
    try {
      const reviewState = await readLatestReviewState(octokit, trusted);
      const assembled = assembleCanonicalReviewReport({
        draft,
        generatedAt: new Date().toISOString(),
        priorReport: reviewState?.baseline?.report ?? null,
        state: current,
      });
      latest = assembled;
      if (!assembled.report) {
        throw new Error("Canonical review report assembly produced no report");
      }
      reviewReportState.update(() => assembled);
      const advanced = advanceReviewRecovery(recovery, {
        stage: "report-reconciled",
      });
      reviewRecoveryState.update(() => advanced);
      await stageReviewPublication({
        context: trusted,
        identity: assembled.identity,
        octokit,
        report: assembled.report,
      });
      return {
        findingCount: assembled.report.findings.length,
        headSha: assembled.identity.headSha,
        recoveryStage: advanced.stage,
        staged: true,
      };
    } catch (error) {
      reviewReportState.update(() => reportAssemblyFailure(latest, error));
      throw error;
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
