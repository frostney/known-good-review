import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Exercises full-report assembly through Eve's local session lifecycle and production schema.",
  tags: ["offline", "review-contract"],
  async test(t) {
    await t.send("KGR-EVAL-FULL-REPORT");

    t.succeeded();
    t.noFailedActions();
    t.calledTool("assemble_review_report", {
      count: 1,
      input: {
        draft: {
          freshFindings: [
            {
              category: "QUALITY",
              title: "Reject stale review fields before execution",
            },
          ],
        },
      },
      output: { accepted: true, findingCount: 1 },
    });
    t.messageIncludes("FULL-REPORT-COMPLETE");
  },
});
