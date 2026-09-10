import { otel } from "eve/instrumentation/otel";

export default otel({
  functionId: "known-good-review",
  traceChannelRequests: true,
  tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
});
