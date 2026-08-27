import { defineTool, toolOutput } from "eve/tools";
import {
  currentReviewReportState,
  reviewReportState,
} from "../lib/review-report";
import {
  currentRecoveryState,
  reviewRecoveryState,
} from "../lib/review-recovery";
import { advanceReviewRecovery } from "../../src/review/recovery";
import {
  recordRevalidationResults,
  reportAssemblyFailure,
} from "../../src/review/report-assembly";
import { recordReviewRevalidationInputSchema } from "../../src/review/tool-inputs";

export { recordReviewRevalidationInputSchema } from "../../src/review/tool-inputs";

export default defineTool({
  description:
    "Persist the complete typed outcomes for every application-selected prior finding. The application validates exact finding IDs and advances revalidation recovery. Values are retained in durable session state for report assembly and recovery.",
  inputSchema: recordReviewRevalidationInputSchema,
  execute({ findings }, ctx) {
    if (ctx.session.parent) {
      throw new Error("Only the review coordinator can record revalidation");
    }
    const recovery = currentRecoveryState(ctx.session.auth.current);
    if (
      recovery.stage !== "axes-complete" &&
      recovery.stage !== "revalidation-complete"
    ) {
      throw new Error("Finding revalidation requires complete review axes");
    }
    if (recovery.selectedFindingIds.length === 0) {
      throw new Error("This review has no selected findings to revalidate");
    }
    const current = currentReviewReportState(ctx.session.auth.current);
    try {
      const next = recordRevalidationResults(current, findings);
      reviewReportState.update(() => next);
      const advanced = advanceReviewRecovery(recovery, {
        stage: "revalidation-complete",
      });
      reviewRecoveryState.update(() => advanced);
      return {
        recordedFindingIds: next.revalidatedFindings.map(({ id }) => id),
        recoveryStage: advanced.stage,
      };
    } catch (error) {
      reviewReportState.update(() => reportAssemblyFailure(current, error));
      throw error;
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
