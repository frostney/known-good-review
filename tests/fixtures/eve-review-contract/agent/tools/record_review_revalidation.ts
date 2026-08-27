import { defineTool, toolOutput } from "eve/tools";
import { recordReviewRevalidationInputSchema } from "../../../../../src/review/tool-inputs";

export default defineTool({
  description:
    "Validate the production delta-revalidation input without changing durable review state.",
  inputSchema: recordReviewRevalidationInputSchema,
  execute({ findings }) {
    return {
      recordedFindingIds: findings.map(({ id }) => id),
    };
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
