import { defineTool, toolOutput } from "eve/tools";
import { assembleReviewReportInputSchema } from "../../../../../src/review/tool-inputs";

export default defineTool({
  description:
    "Validate the production full-review report input without performing publication effects.",
  inputSchema: assembleReviewReportInputSchema,
  execute({ draft }) {
    return {
      accepted: true,
      findingCount: draft.freshFindings.length,
    };
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
