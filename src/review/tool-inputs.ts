import { z } from "zod";
import { reviewFindingSchema } from "./findings";
import { reviewReportDraftSchema } from "./report-assembly";

export const assembleReviewReportInputSchema = z
  .strictObject({
    draft: reviewReportDraftSchema,
  });

export const recordReviewRevalidationInputSchema = z
  .strictObject({
    findings: z.array(reviewFindingSchema).max(100),
  });
