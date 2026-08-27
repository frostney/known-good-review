import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Exercises typed delta revalidation through Eve's local session lifecycle and production schema.",
  tags: ["offline", "review-contract"],
  async test(t) {
    await t.send("KGR-EVAL-DELTA-REVALIDATION");

    t.succeeded();
    t.noFailedActions();
    t.calledTool("record_review_revalidation", {
      count: 1,
      input: {
        findings: [
          {
            category: "QUALITY",
            id: "CR-1",
            status: "fixed",
          },
        ],
      },
      output: { recordedFindingIds: ["CR-1"] },
    });
    t.messageIncludes("DELTA-REVALIDATION-COMPLETE");
  },
});
