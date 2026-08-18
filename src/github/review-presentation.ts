import type { ReviewFinding, ReviewReport } from "../review/findings";
import type { ReviewConfig, ReviewProfile } from "../config/review-config";
import {
  deterministicFindingPresentation,
  renderRichText,
  type CommenterFindingPresentation,
} from "./commenter-presentation";

const severityEmoji: Readonly<Record<ReviewFinding["severity"], string>> = {
  BLOCKING: "🚨",
  IMPORTANT: "⚠️",
  IMPROVEMENT: "💡",
  NITPICK: "🧹",
};

const profileSeverities: Readonly<
  Record<ReviewProfile, ReadonlySet<ReviewFinding["severity"]>>
> = {
  focused: new Set(["BLOCKING", "IMPORTANT"]),
  balanced: new Set(["BLOCKING", "IMPORTANT", "IMPROVEMENT"]),
  thorough: new Set(["BLOCKING", "IMPORTANT", "IMPROVEMENT", "NITPICK"]),
};

export function findingIsPublished(
  finding: ReviewFinding,
  profile: ReviewProfile,
): boolean {
  return finding.status !== "fixed" && profileSeverities[profile].has(finding.severity);
}

export function publishedFindings(
  report: ReviewReport,
  profile: ReviewProfile,
): ReviewFinding[] {
  return report.findings.filter((finding) => findingIsPublished(finding, profile));
}

export function reviewFindingCountSummary(
  report: ReviewReport,
  profile: ReviewProfile = "balanced",
): string {
  const active = report.findings.filter((finding) => finding.status !== "fixed");
  const count = (severity: ReviewFinding["severity"]) =>
    active.filter((finding) => finding.severity === severity).length;
  const improvements = count("IMPROVEMENT");
  const nitpicks = count("NITPICK");
  const profileSummary = (
    emoji: string,
    count: number,
    singular: string,
    plural: string,
    severity: ReviewFinding["severity"],
  ) =>
    !profileSeverities[profile].has(severity) && count > 0
      ? `${emoji} ${count} ${count === 1 ? singular : plural} detected · hidden by ${profile} profile`
      : `${emoji} ${count} ${count === 1 ? singular : plural}`;
  return [
    `🚨 ${count("BLOCKING")} blocking`,
    `⚠️ ${count("IMPORTANT")} important`,
    profileSummary("💡", improvements, "improvement", "improvements", "IMPROVEMENT"),
    profileSummary("🧹", nitpicks, "nitpick", "nitpicks", "NITPICK"),
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
  suppliedPresentation?: CommenterFindingPresentation,
): string {
  const presentation = suppliedPresentation ?? deterministicFindingPresentation(finding);
  const status = finding.status === "open" ? "Open" : titleCase(finding.status);
  return [
    `<!-- known-good-review:finding:${finding.id} -->`,
    `### ${severityEmoji[finding.severity]} ${renderRichText(presentation.title)}`,
    "",
    `**${titleCase(finding.category)} · ${status}**`,
    ...(placement === "file"
      ? ["", `Reported location: \`${finding.location.path}\`, line ${finding.location.line}`]
      : []),
    ...(finding.location.symbol
      ? ["", `Symbol: \`${finding.location.symbol}\``]
      : []),
    "",
    presentation.evidence
      .map((evidence) => `- ${renderRichText(evidence)}`)
      .join("\n"),
    "",
    `Impact: ${renderRichText(presentation.impact)}`,
    "",
    `Smallest remedy: ${renderRichText(presentation.remedy)}`,
  ].join("\n");
}

export function reviewResultBody(
  report: ReviewReport,
  config: Pick<ReviewConfig, "blocking" | "profile"> = {
    blocking: false,
    profile: "balanced",
  },
): string {
  const active = report.findings.filter((finding) => finding.status !== "fixed");
  const published = publishedFindings(report, config.profile);
  const hasBlocking = active.some(
    (finding) => finding.severity === "BLOCKING" || finding.severity === "IMPORTANT",
  );
  const heading = config.blocking && hasBlocking
    ? "## ❌ known-good-review: changes requested"
    : active.length === 0
      ? "## ✅ known-good-review: approved"
      : "## 💬 known-good-review: review complete";
  const result =
    active.length === 0
      ? "No findings were reported."
      : `${active.length} ${active.length === 1 ? "finding was" : "findings were"} detected; ${published.length} ${published.length === 1 ? "was" : "were"} posted inline by the ${config.profile} profile.`;
  return [
    heading,
    "",
    result,
    "",
    reviewFindingCountSummary(report, config.profile),
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
