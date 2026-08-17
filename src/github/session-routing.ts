import type { ChannelFrom } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import { reviewContextAttributes } from "./trusted-context";

export function startsFreshReviewSession(
  auth: SessionAuthContext | null,
): boolean {
  const attributes = auth?.attributes ?? {};
  if (
    attributes[reviewContextAttributes.event] === "review-control-response"
  ) {
    return false;
  }
  const rawPlan = attributes[reviewContextAttributes.plan];
  if (typeof rawPlan !== "string") return false;
  try {
    const plan = JSON.parse(rawPlan) as { kind?: string };
    return plan.kind === "full" || plan.kind === "delta";
  } catch {
    return false;
  }
}

export function withFreshReviewSessions<TState>(
  from: ChannelFrom<TState>,
): ChannelFrom<TState> {
  return (address) => {
    const current = from(address);
    return {
      cancel: (options) => current.cancel(options),
      clear: () => current.clear(),
      compact: () => current.compact(),
      reset: (options) => current.reset(options),
      respond: (responses, options) => current.respond(responses, options),
      send: async (message, options) => {
        if (startsFreshReviewSession(options.auth)) {
          await current.reset({ reason: "new review dispatch" });
        }
        return from(address).send(message, options);
      },
    };
  };
}
