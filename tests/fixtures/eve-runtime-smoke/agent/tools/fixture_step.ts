import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Record one inert child-agent step for the runtime smoke test.",
  inputSchema: z.strictObject({ marker: z.literal("routing") }),
  execute({ marker }) {
    return { marker };
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
