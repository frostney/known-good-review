import { defineWorkflowTool, toolOutput } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Wait durably for a routed child using Eve's bundled Workflow runtime.",
  inputSchema: z.strictObject({ message: z.string().min(1) }),
  async execute({ message }, ctx) {
    "use workflow";
    return await ctx.agent({
      key: "lane:engineering-quality:0",
      target: "agent",
      message,
    });
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
