import { describe, expect, test } from "bun:test";
import {
  findingBody,
  reviewResultBody,
} from "../src/github/review-presentation";
import { reviewCommentLocation } from "../src/github/publication";
import type { ReviewFinding, ReviewReport } from "../src/review/findings";

function finding(
  severity: ReviewFinding["severity"] = "IMPORTANT",
): ReviewFinding {
  return {
    id: "CR-1",
    severity,
    category: "QUALITY",
    title: "The result loses its code location",
    location: { path: "src/review.ts", line: 11, symbol: null },
    evidence: ["The changed branch drops the recorded line."],
    impact: "Readers cannot inspect the affected code directly.",
    remedy: "Attach the finding to the changed line.",
    status: "open",
    staticOnly: false,
    churn: null,
  };
}

function report(findings: readonly ReviewFinding[]): ReviewReport {
  return {
    schemaVersion: 2,
    kind: "code-review",
    generatedAt: "2026-08-17T18:00:00.000Z",
    verdict: findings.length === 0 ? "APPROVE" : "REQUEST_CHANGES",
    scope: {
      claim: "Publish a native review result",
      base: "base",
      head: "head",
      dirtyState: "clean",
    },
    coverage: {
      activeAxes: [
        "deduplication",
        "claim-and-specification",
        "engineering-quality",
      ],
      skippedAxes: [],
      staticOnly: [],
      unreached: [],
    },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
    probes: [],
    findings: [...findings],
    verifiedClaims: [],
    limitations: [],
  };
}

describe("native GitHub review presentation", () => {
  test("renders emoji severity without exposing the internal finding id", () => {
    const body = findingBody(finding());
    const visible = body.replace(/<!--.*?-->/s, "");
    expect(visible).toContain("### ⚠️ The result loses its code location");
    expect(visible).not.toContain("CR-1");
    expect(visible).not.toContain("IMPORTANT");
    expect(visible).toContain("**Quality · Open**");
  });

  test("shows a complete result when no findings qualify", () => {
    const body = reviewResultBody(report([]));
    expect(body).toContain("## ✅ known-good-review: approved");
    expect(body).toContain("No findings were reported.");
    expect(body).toContain("🚨 0 blocking · ⚠️ 0 important · 💡 0 improvements");
  });

  test("summarizes findings while leaving their detail inline", () => {
    const body = reviewResultBody(
      report([finding("IMPORTANT"), { ...finding("IMPROVEMENT"), id: "CR-2" }]),
    );
    expect(body).toContain("2 findings were posted inline");
    expect(body).toContain("⚠️ 1 important");
    expect(body).toContain("💡 1 improvement");
  });

  test("targets the exact head-side diff line and falls back to the file", () => {
    const files = [
      {
        filename: "src/review.ts",
        status: "modified",
        patch: "@@ -10,3 +10,3 @@\n context\n-old\n+new\n context",
      },
    ];
    expect(reviewCommentLocation(finding(), files)).toEqual({
      line: 11,
      side: "RIGHT",
      subjectType: "line",
    });
    expect(
      reviewCommentLocation(
        { ...finding(), location: { ...finding().location, line: 50 } },
        files,
      ),
    ).toEqual({ subjectType: "file" });
    expect(findingBody(finding(), "file")).toContain(
      "Reported location: line 11",
    );
  });

  test("uses the left side for a finding on a deleted line", () => {
    expect(
      reviewCommentLocation(finding(), [
        {
          filename: "src/review.ts",
          status: "removed",
          patch: "@@ -10,2 +0,0 @@\n-old\n-removed",
        },
      ]),
    ).toEqual({ line: 11, side: "LEFT", subjectType: "line" });
  });

  test("does not move a head-side finding onto a deleted line", () => {
    expect(
      reviewCommentLocation(finding(), [
        {
          filename: "src/review.ts",
          status: "modified",
          patch: "@@ -10,2 +10 @@\n context\n-removed",
        },
      ]),
    ).toEqual({ subjectType: "file" });
  });
});
