import { gateway } from "ai";
import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import publishReviewTool from "../tools/publish_review";
import { githubAdapter } from "../../src/github/chat-adapter";
import {
  publishFailClosedCheck,
  writeReviewState,
} from "../../src/github/publication";
import { pendingReviewState } from "../../src/github/review-state";
import {
  reviewContextAttributes,
  trustedGitHubContext,
} from "../../src/github/trusted-context";

const stepModels = new Map<string, string>();
const publishedTurns = new Set<string>();

function stepKey(
  session: string,
  turnId: string,
  stepIndex: number,
): string {
  return `${session}:${turnId}:${stepIndex}`;
}

function reviewKind(attributes: Readonly<Record<string, string | readonly string[]>>) {
  const raw = attributes[reviewContextAttributes.plan];
  if (typeof raw !== "string") return "unknown";
  try {
    const parsed = JSON.parse(raw) as { kind?: string };
    return parsed.kind ?? raw;
  } catch {
    return raw;
  }
}

function parsedPlan(
  attributes: Readonly<Record<string, string | readonly string[]>>,
): { kind: string; reason?: string } | null {
  const raw = attributes[reviewContextAttributes.plan];
  if (typeof raw !== "string") return null;
  if (raw === "cleanup" || raw === "cancel") return { kind: raw };
  try {
    const parsed = JSON.parse(raw) as { kind?: string; reason?: string };
    return typeof parsed.kind === "string"
      ? { kind: parsed.kind, reason: parsed.reason }
      : null;
  } catch {
    return null;
  }
}

export default defineHook({
  events: {
    "action.result"(event, ctx) {
      if (toolResultFrom(event.data.result, publishReviewTool)) {
        publishedTurns.add(`${ctx.session.id}:${event.data.turnId}`);
      }
    },
    "step.started"(event, ctx) {
      stepModels.set(
        stepKey(ctx.session.id, event.data.turnId, event.data.stepIndex),
        event.data.modelId,
      );
    },
    async "step.completed"(event, ctx) {
      const key = stepKey(
        ctx.session.id,
        event.data.turnId,
        event.data.stepIndex,
      );
      const requestedModel = stepModels.get(key) ?? "unknown";
      stepModels.delete(key);
      const generationId = event.data.providerMetadata?.gateway.generationId;
      let generation:
        | Awaited<ReturnType<typeof gateway.getGenerationInfo>>
        | undefined;
      if (generationId) {
        try {
          generation = await gateway.getGenerationInfo({ id: generationId });
        } catch (error) {
          console.warn(
            JSON.stringify({
              event: "known-good-review.telemetry.lookup_failed",
              generationId,
              error: error instanceof Error ? error.name : "unknown",
            }),
          );
        }
      }
      const attributes = ctx.session.auth.current?.attributes ?? {};
      console.info(
        JSON.stringify({
          event: "known-good-review.model.completed",
          sessionId: ctx.session.id,
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          reviewKind: reviewKind(attributes),
          requestedModel,
          actualModel: generation?.model ?? requestedModel,
          fallbackUsed:
            generation !== undefined && generation.model !== requestedModel,
          provider: generation?.providerName ?? null,
          generationId: generationId ?? null,
          inputTokens:
            generation?.promptTokens ?? event.data.usage?.inputTokens ?? 0,
          outputTokens:
            generation?.completionTokens ?? event.data.usage?.outputTokens ?? 0,
          cacheReadTokens:
            generation?.cachedTokens ?? event.data.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens:
            generation?.cacheCreationTokens ??
            event.data.usage?.cacheWriteTokens ??
            0,
          costUsd: generation?.totalCost ?? event.data.usage?.costUsd ?? 0,
          durationMs: generation?.generationTime ?? null,
          latencyMs: generation?.latency ?? null,
          outcome: "succeeded",
        }),
      );
    },
    "step.failed"(event, ctx) {
      const key = stepKey(
        ctx.session.id,
        event.data.turnId,
        event.data.stepIndex,
      );
      const requestedModel = stepModels.get(key) ?? "unknown";
      stepModels.delete(key);
      console.info(
        JSON.stringify({
          event: "known-good-review.model.failed",
          sessionId: ctx.session.id,
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          reviewKind: reviewKind(ctx.session.auth.current?.attributes ?? {}),
          requestedModel,
          actualModel: null,
          fallbackUsed: null,
          code: event.data.code,
          outcome: "failed",
        }),
      );
    },
    async "turn.failed"(event, ctx) {
      const attributes = ctx.session.auth.current?.attributes ?? {};
      const plan = parsedPlan(attributes);
      if (plan?.kind === "full" || plan?.kind === "delta") {
        try {
          const trusted = trustedGitHubContext(ctx.session.auth.current);
          const adapter = githubAdapter(trusted.installationId);
          await publishFailClosedCheck({
            context: trusted,
            message: `Review execution failed closed (${event.data.code}).`,
            octokit: adapter.octokit,
          });
          if (plan.kind === "full" && plan.reason === "initial") {
            await writeReviewState(
              adapter.octokit,
              trusted,
              pendingReviewState({
                pullRequest: trusted.pullRequest,
                status: "failed",
              }),
            );
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "known-good-review.state.fail_closed_failed",
              error: error instanceof Error ? error.name : "unknown",
            }),
          );
        }
      }
      try {
        await (await ctx.getSandbox()).stop();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "known-good-review.sandbox.stop_failed",
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    },
    async "turn.completed"(event, ctx) {
      const key = `${ctx.session.id}:${event.data.turnId}`;
      const attributes = ctx.session.auth.current?.attributes ?? {};
      const plan = parsedPlan(attributes);
      if (
        (plan?.kind === "full" || plan?.kind === "delta") &&
        !publishedTurns.delete(key)
      ) {
        try {
          const trusted = trustedGitHubContext(ctx.session.auth.current);
          const adapter = githubAdapter(trusted.installationId);
          await publishFailClosedCheck({
            context: trusted,
            message:
              "Review execution completed without publishing a validated v2 findings artifact.",
            octokit: adapter.octokit,
          });
          if (plan.kind === "full" && plan.reason === "initial") {
            await writeReviewState(
              adapter.octokit,
              trusted,
              pendingReviewState({
                pullRequest: trusted.pullRequest,
                status: "failed",
              }),
            );
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "known-good-review.state.fail_closed_failed",
              error: error instanceof Error ? error.name : "unknown",
            }),
          );
        }
      }
      try {
        await (await ctx.getSandbox()).stop();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "known-good-review.sandbox.stop_failed",
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    },
    async "turn.cancelled"(_event, ctx) {
      try {
        await (await ctx.getSandbox()).stop();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "known-good-review.sandbox.stop_failed",
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    },
  },
});
