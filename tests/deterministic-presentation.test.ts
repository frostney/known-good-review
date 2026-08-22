import { describe, expect, test } from "bun:test";
import {
  deterministicFindingPresentation,
  renderRichText,
} from "../src/github/deterministic-presentation";
import type { ReviewFinding } from "../src/review/findings";

function finding(): ReviewFinding {
  return {
    id: "CR-1",
    severity: "NITPICK",
    category: "QUALITY",
    title: "Keep README and parseReviewConfig aligned",
    location: {
      path: "docs/README",
      line: 12,
      symbol: "parseReviewConfig",
    },
    evidence: ["docs/README omits the profile option."],
    impact: "parseReviewConfig accepts behavior users cannot discover.",
    remedy: "Document profile in `docs/README`.",
    status: "open",
    staticOnly: false,
    churn: null,
  };
}

describe("deterministic review presentation", () => {
  test("formats paths, extensionless filenames, and symbols without a model", () => {
    const presentation = deterministicFindingPresentation(finding());

    expect(renderRichText(presentation.title)).toBe(
      "Keep `README` and `parseReviewConfig` aligned",
    );
    expect(renderRichText(presentation.evidence[0]!)).toBe(
      "`docs/README` omits the profile option.",
    );
    expect(renderRichText(presentation.remedy)).toBe(
      "Document profile in `docs/README`.",
    );
  });

  test("is byte-stable for the same canonical finding", () => {
    const first = deterministicFindingPresentation(finding());
    const second = deterministicFindingPresentation(finding());

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
