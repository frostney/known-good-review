import { describe, expect, test } from "bun:test";
import {
  deduplicateProductionTelemetry,
  replayLifecycle,
} from "../src/telemetry/replay";

async function fixture() {
  return Bun.file(
    new URL(
      "./fixtures/pascal-mcp-sdk-pr-61-runs.json",
      import.meta.url,
    ),
  ).json();
}

describe("offline production replay", () => {
  test("replays all four PR 61 runs and preserves canonical transitions", async () => {
    const replay = replayLifecycle(await fixture());

    expect(replay.runs).toHaveLength(4);
    expect(
      replay.runs.every(
        (run) =>
          run.laneCheckpoints.length === 4 &&
          run.laneCheckpoints.every(
            (checkpoint) =>
              checkpoint.status === "complete" &&
              checkpoint.remainingEntries.length === 0,
          ),
      ),
    ).toBeTrue();
    expect(replay.runs.map((run) => run.revalidation)).toEqual([
      [],
      [
        { findingId: "CR-1", outcome: "fixed" },
        { findingId: "CR-2", outcome: "fixed" },
        { findingId: "CR-3", outcome: "fixed" },
      ],
      [{ findingId: "CR-5", outcome: "fixed" }],
      [
        { findingId: "CR-6", outcome: "fixed" },
        { findingId: "CR-7", outcome: "fixed" },
      ],
    ]);
    expect(replay.runs.map((run) => run.findingTransitions)).toEqual([
      [
        { findingId: "CR-1", before: "absent", after: "open" },
        { findingId: "CR-2", before: "absent", after: "open" },
        { findingId: "CR-3", before: "absent", after: "open" },
        { findingId: "CR-4", before: "absent", after: "open" },
      ],
      [
        { findingId: "CR-1", before: "open", after: "fixed" },
        { findingId: "CR-2", before: "open", after: "fixed" },
        { findingId: "CR-3", before: "open", after: "fixed" },
        { findingId: "CR-4", before: "open", after: "open" },
        { findingId: "CR-5", before: "absent", after: "open" },
      ],
      [
        { findingId: "CR-4", before: "open", after: "open" },
        { findingId: "CR-5", before: "open", after: "fixed" },
        { findingId: "CR-6", before: "absent", after: "open" },
        { findingId: "CR-7", before: "absent", after: "open" },
      ],
      [
        { findingId: "CR-4", before: "open", after: "open" },
        { findingId: "CR-6", before: "open", after: "fixed" },
        { findingId: "CR-7", before: "open", after: "fixed" },
      ],
    ]);
    expect(replay.runs[3]?.publication).toEqual({
      attempts: 0,
      published: false,
      recoveryWork: ["report-reconciliation", "publication"],
    });
  });

  test("reports phase comparisons and stable common-work reuse without gating", async () => {
    const replay = replayLifecycle(await fixture());

    for (const run of replay.runs) {
      const axes = run.phases.find((phase) => phase.phase === "fresh-axes");
      expect(axes?.candidateMs).toBeLessThan(axes?.recordedMs ?? 0);
      expect(run.parallelWorkerConsumptionMs).toBeGreaterThan(
        axes?.candidateMs ?? 0,
      );
      expect(run.commonWork.every((work) => work.candidateOccurrences === 1)).toBeTrue();
      expect(new Set(run.commonWork.map((work) => work.stableId)).size).toBe(
        run.commonWork.length,
      );
      expect(run.measurementPolicy).toBe("non-gating");
      expect(run).not.toHaveProperty("accepted");
      expect(run).not.toHaveProperty("rejected");
    }
  });

  test("preserves exact four-run usage and cumulative lifecycle cost", async () => {
    const replay = replayLifecycle(await fixture());

    expect(replay.cumulative).toMatchObject({
      inputTokens: 6_026_639,
      cachedInputTokens: 4_958_245,
      cacheCreationInputTokens: 1_067_587,
      outputTokens: 164_220,
      publicationAttempts: 3,
    });
    expect(replay.cumulative.costUsd).toBeCloseTo(5.3044305, 7);
    expect(replay.cumulative.candidateCriticalPathMs).toBeLessThan(
      replay.cumulative.recordedCriticalPathMs,
    );
    expect(replay.measurementPolicy).toBe("non-gating");
  });
});

describe("production telemetry identity", () => {
  const event = {
    runId: "wrun_one",
    sessionId: "session_one",
    generationId: "generation_one",
    phase: "fresh-axes",
    attempt: 0,
    outcome: "succeeded" as const,
    usage: {
      inputTokens: 10,
      cachedInputTokens: 7,
      cacheCreationInputTokens: 3,
      outputTokens: 2,
      costUsd: 0.01,
    },
  };

  test("deduplicates repeated delivery by run, session, and generation", () => {
    expect(deduplicateProductionTelemetry([event, event])).toEqual([event]);
    expect(
      deduplicateProductionTelemetry([
        event,
        { ...event, generationId: "generation_two" },
      ]),
    ).toHaveLength(2);
  });

  test("fails closed on conflicting measurements for one identity", () => {
    expect(() =>
      deduplicateProductionTelemetry([
        event,
        { ...event, usage: { ...event.usage, inputTokens: 11 } },
      ]),
    ).toThrow("Conflicting production telemetry");
  });
});
