import { z } from "zod";
import type { ReviewFinding } from "../review/findings";

export const richTextSegmentSchema = z
  .object({
    kind: z.enum(["text", "code"]),
    value: z.string().min(1),
  })
  .strict();

export const richTextSchema = z.array(richTextSegmentSchema).min(1);
export type RichText = z.infer<typeof richTextSchema>;

export interface FindingPresentation {
  readonly title: RichText;
  readonly evidence: readonly RichText[];
  readonly impact: RichText;
  readonly remedy: RichText;
}

function codeFence(value: string): string {
  const longest = Math.max(
    0,
    ...[...value.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longest + 1);
  return `${fence}${value}${fence}`;
}

export function renderRichText(parts: RichText): string {
  return parts
    .map((part) => (part.kind === "code" ? codeFence(part.value) : part.value))
    .join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codeRanges(source: string, explicitTokens: readonly string[]) {
  const ranges: Array<{ start: number; end: number }> = [];
  const record = (start: number, value: string) => {
    if (value.length > 0) ranges.push({ start, end: start + value.length });
  };
  for (const token of explicitTokens.filter((value) => value.length > 0)) {
    const pattern = new RegExp(escapeRegExp(token), "g");
    for (const match of source.matchAll(pattern)) {
      if (match.index !== undefined) record(match.index, match[0]);
    }
  }
  for (const pattern of [
    /(?:\.\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*[A-Za-z0-9_-]/g,
    /\b[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,9}\b/g,
    /\b[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\()/g,
    /\b(?:[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z0-9]+_[A-Za-z0-9_]+)\b/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match.index !== undefined) record(match.index, match[0]);
    }
  }
  return ranges;
}

function deterministicParts(
  source: string,
  finding: ReviewFinding,
): RichText {
  const explicitMarkdown = [...source.matchAll(/`([^`\n]+)`/g)].flatMap(
    (match) => (match[1] === undefined ? [] : [match[1]]),
  );
  const visible = source.replace(/`([^`\n]+)`/g, "$1");
  const pathParts = finding.location.path.split("/");
  const explicitTokens = [
    ...explicitMarkdown,
    finding.location.path,
    pathParts.at(-1) ?? "",
    finding.location.symbol ?? "",
  ];
  const code = new Uint8Array(visible.length);
  for (const range of codeRanges(visible, explicitTokens)) {
    code.fill(1, range.start, range.end);
  }
  const parts: Array<{ kind: "code" | "text"; value: string }> = [];
  let start = 0;
  while (start < visible.length) {
    const kind = code[start] === 1 ? "code" : "text";
    let end = start + 1;
    while (end < visible.length && (code[end] === 1 ? "code" : "text") === kind) {
      end += 1;
    }
    parts.push({ kind, value: visible.slice(start, end) });
    start = end;
  }
  return richTextSchema.parse(
    parts.length > 0 ? parts : [{ kind: "text", value: visible }],
  );
}

export function deterministicFindingPresentation(
  finding: ReviewFinding,
): FindingPresentation {
  return {
    title: deterministicParts(finding.title, finding),
    evidence: finding.evidence.map((value) => deterministicParts(value, finding)),
    impact: deterministicParts(finding.impact, finding),
    remedy: deterministicParts(finding.remedy, finding),
  };
}
