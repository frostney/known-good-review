import { defineTool } from "eve/tools";
import { z } from "zod";
import { writeReviewEvidenceManifest } from "../../../../../src/review/evidence-bundle";
import { evidenceSandbox, identity } from "../lib/orchestration";

export default defineTool({
  description: "Prepare signed synthetic review artifacts for the runtime smoke.", inputSchema: z.strictObject({}),
  async execute(_input, ctx) {
    const sandbox = await evidenceSandbox(ctx);
    await writeReviewEvidenceManifest(sandbox, { schemaVersion: 1, ...identity, entries: [] });
    return { prepared: true };
  },
});
