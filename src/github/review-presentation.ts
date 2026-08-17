import type { ReviewFinding, ReviewReport } from "../review/findings";

const severityEmoji: Readonly<Record<ReviewFinding["severity"], string>> = {
  BLOCKING: "🚨",
  IMPORTANT: "⚠️",
  IMPROVEMENT: "💡",
};

export function reviewFindingCountSummary(report: ReviewReport): string {
  const active = report.findings.filter((finding) => finding.status !== "fixed");
  const count = (severity: ReviewFinding["severity"]) =>
    active.filter((finding) => finding.severity === severity).length;
  const improvements = count("IMPROVEMENT");
  return [
    `🚨 ${count("BLOCKING")} blocking`,
    `⚠️ ${count("IMPORTANT")} important`,
    `💡 ${improvements} ${improvements === 1 ? "improvement" : "improvements"}`,
  ].join(" · ");
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function findingBody(
  finding: ReviewFinding,
  placement: "file" | "line" = "line",
): string {
  const status = finding.status === "open" ? "Open" : titleCase(finding.status);
  return [
    `<!-- known-good-review:finding:${finding.id} -->`,
    `### ${severityEmoji[finding.severity]} ${finding.title}`,
    "",
    `**${titleCase(finding.category)} · ${status}**`,
    ...(placement === "file"
      ? ["", `Reported location: line ${finding.location.line}`]
      : []),
    "",
    finding.evidence.map((evidence) => `- ${evidence}`).join("\n"),
    "",
    `Impact: ${finding.impact}`,
    "",
    `Smallest remedy: ${finding.remedy}`,
  ].join("\n");
}

export function reviewResultBody(report: ReviewReport): string {
  const active = report.findings.filter((finding) => finding.status !== "fixed");
  const heading =
    report.verdict === "APPROVE"
      ? "## ✅ known-good-review: approved"
      : report.verdict === "APPROVE_WITH_IMPROVEMENTS"
        ? "## 💡 known-good-review: approved with improvements"
        : "## ❌ known-good-review: changes requested";
  const result =
    active.length === 0
      ? "No findings were reported."
      : `${active.length} ${active.length === 1 ? "finding was" : "findings were"} posted inline on the changed files.`;
  return [
    heading,
    "",
    result,
    "",
    reviewFindingCountSummary(report),
    "",
    "See the Check Run for review coverage and limitations.",
  ].join("\n");
}

export function reviewProgressBody(
  status: "completed" | "debouncing" | "failed" | "never" | "running",
): string {
  if (status === "debouncing") {
    return [
      "## ⏳ known-good-review: accepted",
      "",
      "The review is queued for its debounce window.",
    ].join("\n");
  }
  if (status === "running") {
    return [
      "## ⏳ known-good-review: in progress",
      "",
      "The review is currently running.",
    ].join("\n");
  }
  if (status === "failed" || status === "completed") {
    return [
      "## ❌ known-good-review: review incomplete",
      "",
      "The review did not complete. See the Check Run for details.",
    ].join("\n");
  }
  return [
    "## ⏸️ known-good-review: not started",
    "",
    "No review has started yet.",
  ].join("\n");
}
