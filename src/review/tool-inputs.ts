import { z } from "zod";
import { reviewFindingSchema } from "./findings";
import { reviewReportDraftSchema } from "./report-assembly";

export const assembleReviewReportInputSchema = z
  .object({
    draft: reviewReportDraftSchema,
  })
  .strict();

export const recordReviewRevalidationInputSchema = z
  .object({
    findings: z.array(reviewFindingSchema).max(100),
  })
  .strict();
