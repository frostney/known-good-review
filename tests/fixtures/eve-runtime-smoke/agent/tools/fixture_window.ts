import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowProbe } from "../lib/workflow-window";

export default defineTool({
  description: "Enable synthetic GitHub coordinator authority for the cutoff probe.",
  inputSchema: z.strictObject({}),
  execute() {
    windowProbe.update(() => true);
    return { enabled: true };
  },
});
