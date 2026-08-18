import { z } from "zod";
import type { ReviewFinding, ReviewReport } from "../review/findings";

export const richTextSegmentSchema = z
  .object({
    kind: z.enum(["text", "code"]),
    value: z.string().min(1),
  })
  .strict();

export const richTextSchema = z.array(richTextSegmentSchema).min(1);

export const commenterPresentationSchema = z
  .object({
    findings: z.array(
      z
        .object({
          id: z.string().regex(/^CR-[1-9]\d*$/),
          title: richTextSchema,
          evidence: z.array(richTextSchema).min(1),
          impact: richTextSchema,
          remedy: richTextSchema,
        })
        .strict(),
    ),
  })
  .strict();

export type RichText = z.infer<typeof richTextSchema>;
export type CommenterPresentation = z.infer<typeof commenterPresentationSchema>;
export type CommenterFindingPresentation = CommenterPresentation["findings"][number];

function canonicalVisibleText(value: string): string {
  return value.replace(/`([^`\n]+)`/g, "$1");
}

function joined(parts: RichText): string {
  return parts.map((part) => part.value).join("");
}

const obviousBareCode = [
  /(?:^|[\s("'])((?:\.\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)/,
  /\b[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,9}\b/,
  /\b[A-Za-z_$][A-Za-z0-9_$]*\s*\(/,
  /\b(?:[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z0-9]+_[A-Za-z0-9_]+)\b/,
] as const;

function validateNoObviousBareCode(parts: RichText, field: string): void {
  for (const part of parts) {
    if (part.kind !== "text") continue;
    const withoutUrls = part.value.replace(/https?:\/\/\S+/g, "");
    if (obviousBareCode.some((pattern) => pattern.test(withoutUrls))) {
      throw new Error(`${field} leaves a code-shaped identifier outside a code segment`);
    }
  }
}

function validateExactField(
  parts: RichText,
  source: string,
  field: string,
): void {
  if (joined(parts) !== canonicalVisibleText(source)) {
    throw new Error(`${field} must preserve the canonical finding text exactly`);
  }
  validateNoObviousBareCode(parts, field);
}

export function validateCommenterPresentation(
  report: ReviewReport,
  input: CommenterPresentation,
): CommenterPresentation {
  const presentation = commenterPresentationSchema.parse(input);
  const expected = report.findings.filter((finding) => finding.status !== "fixed");
  if (presentation.findings.length !== expected.length) {
    throw new Error("Commenter output must cover every active canonical finding exactly once");
  }
  const byId = new Map(
    presentation.findings.map((finding) => [finding.id, finding] as const),
  );
  if (byId.size !== presentation.findings.length) {
    throw new Error("Commenter output contains duplicate finding identities");
  }
  for (const finding of expected) {
    const rendered = byId.get(finding.id);
    if (!rendered) {
      throw new Error(`Commenter output is missing ${finding.id}`);
    }
    validateExactField(rendered.title, finding.title, `${finding.id}.title`);
    if (rendered.evidence.length !== finding.evidence.length) {
      throw new Error(`${finding.id}.evidence must preserve every evidence item`);
    }
    finding.evidence.forEach((evidence, index) => {
      const parts = rendered.evidence[index];
      if (!parts) throw new Error(`${finding.id}.evidence is incomplete`);
      validateExactField(parts, evidence, `${finding.id}.evidence[${index}]`);
    });
    validateExactField(rendered.impact, finding.impact, `${finding.id}.impact`);
    validateExactField(rendered.remedy, finding.remedy, `${finding.id}.remedy`);
  }
  return presentation;
}

function codeFence(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${value}${fence}`;
}

export function renderRichText(parts: RichText): string {
  return parts
    .map((part) => (part.kind === "code" ? codeFence(part.value) : part.value))
    .join("");
}

function deterministicParts(value: string): RichText {
  const parts: Array<{ kind: "code" | "text"; value: string }> = [];
  let cursor = 0;
  for (const match of value.matchAll(/`([^`\n]+)`/g)) {
    if (match.index === undefined || match[1] === undefined) continue;
    if (match.index > cursor) {
      parts.push({ kind: "text", value: value.slice(cursor, match.index) });
    }
    parts.push({ kind: "code", value: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) {
    parts.push({ kind: "text", value: value.slice(cursor) });
  }
  return richTextSchema.parse(parts.length > 0 ? parts : [{ kind: "text", value }]);
}

export function deterministicFindingPresentation(
  finding: ReviewFinding,
): CommenterFindingPresentation {
  return {
    id: finding.id,
    title: deterministicParts(finding.title),
    evidence: finding.evidence.map(deterministicParts),
    impact: deterministicParts(finding.impact),
    remedy: deterministicParts(finding.remedy),
  };
}
