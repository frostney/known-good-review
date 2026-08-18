import { createHash } from "node:crypto";
import type { ReviewFinding } from "./findings";

function normalizeIdentityText(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

export function findingIdentity(
  finding: Pick<ReviewFinding, "category" | "title" | "impact" | "remedy">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        category: finding.category,
        cause: normalizeIdentityText(finding.title),
        invariant: normalizeIdentityText(finding.impact),
        remedy: normalizeIdentityText(finding.remedy),
      }),
    )
    .digest("hex");
}
