import { gateway } from "ai";
import { defineHook, type HookContext } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import publishReviewTool from "../tools/publish_review";
import { githubAdapter } from "../../src/github/chat-adapter";
import {
  publishBudgetExhaustedCheck,
  publishFailClosedCheck,
  writeReviewFailureState,
} from "../../src/github/publication";
import {
  reviewContextAttributes,
  trustedGitHubContext,
} from "../../src/github/trusted-context";
import { memoryPolicyHash } from "../../src/memory/policy";
import {
  parseSubagentRoute,
  type ReviewRoute,
} from "../../src/models/routing";
import { shadowInputExceedances } from "../../src/telemetry/budget-policy";
import { ownsReviewLifecycle } from "../../src/review/execution-session";
import { readLaneCheckpoint } from "../../src/review/lane-checkpoint";
import {
  advanceReviewRecovery,
  buildReviewFailureEnvelope,
  reviewRecoveryStateSchema,
  type ReviewFailureEnvelope,
  type ReviewRecoveryState,
} from "../../src/review/recovery";
import {
  currentRecoveryState,
  recoveryStateFromAuth,
  reviewRecoveryState,
} from "../lib/review-recovery";
import { z } from "zod";

const stepRoutes = new Map<
  string,
  { readonly requestedModel: string; readonly route: ReviewRoute }
>();
const sessionRoutes = new Map<string, ReviewRoute>();
const publishedTurns = new Set<string>();
const turnUsage = new Map<
  string,
  { inputTokens: number; outputTokens: number }
>();

const sessionLimitDetailsSchema = z.object({
  kind: z.enum(["input", "output"]),
  limit: z.number().int().positive(),
  usedTokens: z.number().int().nonnegative(),
});

function stepKey(
  session: string,
  turnId: string,
  stepIndex: number,
): string {
  return `${session}:${turnId}:${stepIndex}`;
}

function turnKey(session: string, turnId: string): string {
  return `${session}:${turnId}`;
}

function isLifecycleOwner(ctx: {
  readonly channel: { readonly kind?: string };
  readonly session: { readonly parent?: unknown };
}): boolean {
  return ownsReviewLifecycle({
    channelKind: ctx.channel.kind,
    hasParent: ctx.session.parent !== undefined,
  });
}

function executionRoute(
  channelKind: string | undefined,
  sessionId: string,
): ReviewRoute {
  if (channelKind !== "subagent") {
    return { role: "coordinator", attempt: 0 };
  }
  return (
    sessionRoutes.get(sessionId) ?? { role: "coordinator", attempt: 0 }
  );
}

function reviewAxis(route: ReviewRoute): string {
  if (route.role === "lane") return route.axis;
  return route.role;
}

function symbolicErrorClass(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 64);
  return /^[A-Z]/.test(normalized)
    ? normalized
    : `TURN_${normalized}`.slice(0, 64);
}

async function recoveryWithObservedAxes(
  ctx: HookContext,
): Promise<ReviewRecoveryState> {
  let recovery = currentRecoveryState(ctx.session.auth.current);
  const trusted = trustedGitHubContext(ctx.session.auth.current);
  if (!trusted.patchFingerprint) {
    throw new Error("Trusted review recovery is missing patch identity");
  }
  const sandbox = await ctx.getSandbox();
  const completedAxes: typeof recovery.completedAxes = [];
  for (const axis of recovery.activeAxes) {
    const checkpoint = await readLaneCheckpoint(
      sandbox,
      {
        baseSha: trusted.baseSha,
        headSha: trusted.headSha,
        patchFingerprint: trusted.patchFingerprint,
      },
      axis,
    );
    if (checkpoint?.status === "complete") completedAxes.push(axis);
  }
  recovery =
    recovery.stage === "started" &&
    completedAxes.length === recovery.activeAxes.length
      ? advanceReviewRecovery(recovery, {
          completedAxes,
          stage: "axes-complete",
        })
      : reviewRecoveryStateSchema.parse({ ...recovery, completedAxes });
  reviewRecoveryState.update(() => recovery);
  return recovery;
}

async function failureEnvelope(
  ctx: HookContext,
  turnId: string,
  errorClass: string,
  retryEligible?: boolean,
): Promise<ReviewFailureEnvelope> {
  return buildReviewFailureEnvelope({
    errorClass: symbolicErrorClass(errorClass),
    recovery: await recoveryWithObservedAxes(ctx),
    ...(retryEligible === undefined ? {} : { retryEligible }),
    run: { sessionId: ctx.session.id, turnId },
  });
}

async function observedFailureEnvelope(
  ctx: HookContext,
  turnId: string,
  errorClass: string,
  retryEligible?: boolean,
): Promise<ReviewFailureEnvelope | null> {
  try {
    return await failureEnvelope(ctx, turnId, errorClass, retryEligible);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "known-good-review.state.failure_envelope_unavailable",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return null;
  }
}

function failureSummary(failure: ReviewFailureEnvelope): string {
  const completed =
    failure.completedAxes.length > 0
      ? failure.completedAxes.join(", ")
      : "none";
  return [
    `Review execution stopped at ${failure.failedStage}.`,
    `Completed axes: ${completed}.`,
    `Recovery revision: ${failure.executionRevision}.`,
    `Retry eligible: ${failure.retryEligible ? "yes" : "no"}.`,
    `Error class: ${failure.errorClass}.`,
  ].join(" ");
}

async function persistFailureEnvelope(
  context: ReturnType<typeof trustedGitHubContext>,
  failure: ReviewFailureEnvelope | null,
  octokit: ReturnType<typeof githubAdapter>["octokit"],
): Promise<boolean> {
  if (!failure) return false;
  try {
    await writeReviewFailureState({ context, failure, octokit });
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "known-good-review.state.failure_envelope_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return false;
  }
}

function recordTurnUsage(
  session: string,
  turnId: string,
  inputTokens: number,
  outputTokens: number,
): void {
  const key = turnKey(session, turnId);
  const current = turnUsage.get(key) ?? { inputTokens: 0, outputTokens: 0 };
  turnUsage.set(key, {
    inputTokens: current.inputTokens + inputTokens,
    outputTokens: current.outputTokens + outputTokens,
  });
}

function logTurnUsage(sessionId: string, turnId: string): void {
  const usage = turnUsage.get(turnKey(sessionId, turnId));
  turnUsage.delete(turnKey(sessionId, turnId));
  if (!usage) return;
  console.info(
    JSON.stringify({
      event: "known-good-review.budget.completed",
      sessionId,
      turnId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      shadowInputExceedances: shadowInputExceedances(usage.inputTokens),
    }),
  );
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
      ? {
          kind: parsed.kind,
          ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
        }
      : null;
  } catch {
    return null;
  }
}

export default defineHook({
  events: {
    "turn.started"(_event, ctx) {
      if (!isLifecycleOwner(ctx)) return;
      const attributes = ctx.session.auth.current?.attributes ?? {};
      const plan = parsedPlan(attributes);
      if (plan?.kind !== "full" && plan?.kind !== "delta") return;
      if (
        attributes[reviewContextAttributes.event] === "review-control-response"
      ) {
        return;
      }
      reviewRecoveryState.update(() =>
        recoveryStateFromAuth(ctx.session.auth.current),
      );
    },
    "message.received"(event, ctx) {
      if (ctx.channel.kind !== "subagent") return;
      try {
        sessionRoutes.set(
          ctx.session.id,
          parseSubagentRoute([
            { role: "user", content: event.data.message },
          ]),
        );
      } catch {
        sessionRoutes.delete(ctx.session.id);
      }
    },
    "action.result"(event, ctx) {
      if (toolResultFrom(event.data.result, publishReviewTool)) {
        publishedTurns.add(`${ctx.session.id}:${event.data.turnId}`);
        const recovery = reviewRecoveryState.get();
        if (recovery?.stage === "report-reconciled") {
          reviewRecoveryState.update(() =>
            advanceReviewRecovery(recovery, { stage: "published" }),
          );
        }
      }
    },
    "step.started"(event, ctx) {
      stepRoutes.set(
        stepKey(ctx.session.id, event.data.turnId, event.data.stepIndex),
        {
          requestedModel: event.data.modelId,
          route: executionRoute(ctx.channel.kind, ctx.session.id),
        },
      );
    },
    async "step.completed"(event, ctx) {
      const key = stepKey(
        ctx.session.id,
        event.data.turnId,
        event.data.stepIndex,
      );
      const step = stepRoutes.get(key);
      const requestedModel = step?.requestedModel ?? "unknown";
      const route =
        step?.route ?? executionRoute(ctx.channel.kind, ctx.session.id);
      stepRoutes.delete(key);
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
      const inputTokens =
        generation?.promptTokens ?? event.data.usage?.inputTokens ?? 0;
      const outputTokens =
        generation?.completionTokens ?? event.data.usage?.outputTokens ?? 0;
      recordTurnUsage(
        ctx.session.id,
        event.data.turnId,
        inputTokens,
        outputTokens,
      );
      console.info(
        JSON.stringify({
          event: "known-good-review.model.completed",
          sessionId: ctx.session.id,
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          reviewKind: reviewKind(attributes),
          reviewAxis: reviewAxis(route),
          memoryPolicyHash: memoryPolicyHash(),
          requestedModel,
          actualModel: generation?.model ?? requestedModel,
          fallbackUsed:
            generation !== undefined && generation.model !== requestedModel,
          provider: generation?.providerName ?? null,
          generationId: generationId ?? null,
          inputTokens,
          outputTokens,
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
      const step = stepRoutes.get(key);
      const requestedModel = step?.requestedModel ?? "unknown";
      const route =
        step?.route ?? executionRoute(ctx.channel.kind, ctx.session.id);
      stepRoutes.delete(key);
      console.info(
        JSON.stringify({
          event: "known-good-review.model.failed",
          sessionId: ctx.session.id,
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          reviewKind: reviewKind(ctx.session.auth.current?.attributes ?? {}),
          reviewAxis: reviewAxis(route),
          memoryPolicyHash: memoryPolicyHash(),
          requestedModel,
          actualModel: null,
          fallbackUsed: null,
          code: event.data.code,
          outcome: "failed",
        }),
      );
    },
    async "turn.failed"(event, ctx) {
      logTurnUsage(ctx.session.id, event.data.turnId);
      if (!isLifecycleOwner(ctx)) {
        publishedTurns.delete(`${ctx.session.id}:${event.data.turnId}`);
        sessionRoutes.delete(ctx.session.id);
        return;
      }
      const attributes = ctx.session.auth.current?.attributes ?? {};
      const plan = parsedPlan(attributes);
      const route = executionRoute(ctx.channel.kind, ctx.session.id);
      if (plan?.kind === "full" || plan?.kind === "delta") {
        try {
          const trusted = trustedGitHubContext(ctx.session.auth.current);
          const adapter = githubAdapter(trusted.installationId);
          const limit =
            event.data.code === "SESSION_TOKEN_LIMIT_REACHED"
              ? sessionLimitDetailsSchema.safeParse(event.data.details)
              : null;
          const failure = await observedFailureEnvelope(
            ctx,
            event.data.turnId,
            event.data.code,
            limit?.success ? false : undefined,
          );
          const recoveryAvailable = await persistFailureEnvelope(
            trusted,
            failure,
            adapter.octokit,
          );
          if (limit?.success) {
            await publishBudgetExhaustedCheck({
              context: trusted,
              budgetAxis: limit.data.kind,
              reviewAxis: reviewAxis(route),
              usedTokens: limit.data.usedTokens,
              limit: limit.data.limit,
              octokit: adapter.octokit,
            });
          } else {
            await publishFailClosedCheck({
              context: trusted,
              message: failure && recoveryAvailable
                ? failureSummary(failure)
                : `Review execution failed closed (${symbolicErrorClass(event.data.code)}). Recovery state is unavailable; continuation is disabled.`,
              octokit: adapter.octokit,
            });
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
      logTurnUsage(ctx.session.id, event.data.turnId);
      const key = `${ctx.session.id}:${event.data.turnId}`;
      if (!isLifecycleOwner(ctx)) {
        publishedTurns.delete(key);
        sessionRoutes.delete(ctx.session.id);
        return;
      }
      const attributes = ctx.session.auth.current?.attributes ?? {};
      const plan = parsedPlan(attributes);
      if (
        (plan?.kind === "full" || plan?.kind === "delta") &&
        !publishedTurns.delete(key)
      ) {
        try {
          const trusted = trustedGitHubContext(ctx.session.auth.current);
          const adapter = githubAdapter(trusted.installationId);
          const failure = await observedFailureEnvelope(
            ctx,
            event.data.turnId,
            "WORKFLOW_INCOMPLETE",
          );
          const recoveryAvailable = await persistFailureEnvelope(
            trusted,
            failure,
            adapter.octokit,
          );
          await publishFailClosedCheck({
            context: trusted,
            message: failure && recoveryAvailable
              ? failureSummary(failure)
              : "Review execution completed without publishing a validated v2 findings artifact. Recovery state is unavailable; continuation is disabled.",
            octokit: adapter.octokit,
          });
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
      if (!isLifecycleOwner(ctx)) {
        sessionRoutes.delete(ctx.session.id);
        return;
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
  },
});
