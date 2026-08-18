import { describe, expect, test } from "bun:test";
import {
  renderRichText,
  validateCommenterPresentation,
  type CommenterPresentation,
} from "../src/github/commenter-presentation";
import type { ReviewReport } from "../src/review/findings";

function report(): ReviewReport {
  return {
    schemaVersion: 2,
    kind: "code-review",
    generatedAt: "2026-08-18T00:00:00.000Z",
    verdict: "APPROVE_WITH_IMPROVEMENTS",
    scope: {
      claim: "Format code identifiers",
      base: "base",
      head: "head",
      dirtyState: "clean",
    },
    coverage: {
      activeAxes: ["engineering-quality"],
      skippedAxes: [],
      staticOnly: [],
      unreached: [],
    },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
    probes: [],
    findings: [
      {
        id: "CR-1",
        severity: "NITPICK",
        category: "QUALITY",
        title: "Keep README and parseReviewConfig aligned",
        location: { path: "README", line: 12, symbol: "parseReviewConfig" },
        evidence: ["README omits the profile option."],
        impact: "parseReviewConfig accepts behavior users cannot discover.",
        remedy: "Document profile in README.",
        status: "open",
        staticOnly: false,
        churn: null,
      },
    ],
    verifiedClaims: [],
    limitations: [],
  };
}

function presentation(): CommenterPresentation {
  return {
    findings: [
      {
        id: "CR-1",
        title: [
          { kind: "text", value: "Keep " },
          { kind: "code", value: "README" },
          { kind: "text", value: " and " },
          { kind: "code", value: "parseReviewConfig" },
          { kind: "text", value: " aligned" },
        ],
        evidence: [[
          { kind: "code", value: "README" },
          { kind: "text", value: " omits the profile option." },
        ]],
        impact: [
          { kind: "code", value: "parseReviewConfig" },
          { kind: "text", value: " accepts behavior users cannot discover." },
        ],
        remedy: [
          { kind: "text", value: "Document profile in " },
          { kind: "code", value: "README" },
          { kind: "text", value: "." },
        ],
      },
    ],
  };
}

describe("commenter presentation contract", () => {
  test("preserves canonical text and renders every classified identifier as code", () => {
    const validated = validateCommenterPresentation(report(), presentation());
    expect(renderRichText(validated.findings[0]!.title)).toBe(
      "Keep `README` and `parseReviewConfig` aligned",
    );
  });

  test("rejects paraphrases and obvious bare code identifiers", () => {
    const paraphrased = presentation();
    paraphrased.findings[0]!.title = [{ kind: "text", value: "Different title" }];
    expect(() => validateCommenterPresentation(report(), paraphrased)).toThrow(
      "preserve the canonical finding text exactly",
    );

    const bare = presentation();
    bare.findings[0]!.impact = [
      {
        kind: "text",
        value: "parseReviewConfig accepts behavior users cannot discover.",
      },
    ];
    expect(() => validateCommenterPresentation(report(), bare)).toThrow(
      "outside a code segment",
    );
  });
});
