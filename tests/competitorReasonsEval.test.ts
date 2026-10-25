import { describe, expect, it, vi } from "vitest";
import {
  runEvaluation,
  runLiveEvaluation,
  verifyThreadDeduplication,
} from "../scripts/eval-competitor-reasons";

describe("competitor reasons evaluation harness and fixture regression checks", () => {
  const metrics = runEvaluation();
  const dedup = verifyThreadDeduplication();

  it("evaluates a synthetic held-out benchmark dataset across multiple competitors and edge cases without live paid calls", () => {
    expect(metrics.sampleSize).toBe(28);
    // Explicit switching intent should maintain high precision on benchmark fixtures
    expect(metrics.switching.precision).toBeGreaterThanOrEqual(0.85);
    expect(metrics.switching.recall).toBeGreaterThanOrEqual(0.85);
  });

  it("never falsely alarms on users who explicitly intend to stay", () => {
    // Users with compliance or API lock-in must never be flagged as potential switchers
    expect(metrics.edgeCaseAnalysis.stayingIntentFalsePositiveRate).toBe(0.0);
  });

  it("accurately records and bounds edge-case errors on synthetic challenge fixtures (sarcasm and mixed sentiment)", () => {
    // Sarcasm and mixed sentiment are known realistic edge-case challenges in production NLP
    expect(metrics.edgeCaseAnalysis.sarcasmErrorRate).toBeGreaterThan(0.0);
    expect(metrics.edgeCaseAnalysis.mixedSentimentErrorRate).toBeGreaterThan(0.0);
    // Overall reason accuracy on benchmark edge cases remains robust (> 80%)
    expect(metrics.reasonCategories.accuracy).toBeGreaterThanOrEqual(0.8);
    expect(metrics.reasonCategories.abstainedUnknownCount).toBe(3);
  });

  it("verifies distinct-thread deduplication and non-inflation of recurring patterns", () => {
    // Single thread with 3 replies must only count as 1 distinct thread
    expect(dedup.singleThread.distinctThreads).toBe(1);
    expect(dedup.singleThread.totalMentions).toBe(3);
    expect(dedup.singleThread.isRecurring).toBe(false);

    // Multiple independent threads must be marked as recurring
    expect(dedup.multiThread.distinctThreads).toBe(2);
    expect(dedup.multiThread.isRecurring).toBe(true);

    // Switcher opportunities in a thread are unified into one card
    expect(dedup.switcherDeduplication.totalFound).toBe(1);
    expect(dedup.switcherDeduplication.signal).toBe("actively_switching");
  });

  it("asserts that live evaluation fails cleanly without prerequisites and does not fall back to fixture data", async () => {
    const origKey = process.env.OPENROUTER_API_KEY;

    try {
      delete process.env.OPENROUTER_API_KEY;
      await expect(runLiveEvaluation()).rejects.toThrow(
        /prerequisite failed: OPENROUTER_API_KEY is not configured/i,
      );
    } finally {
      vi.restoreAllMocks();
      if (origKey !== undefined) {
        process.env.OPENROUTER_API_KEY = origKey;
      }
    }
  });

  it("asserts that live evaluation fails cleanly when database is unreachable and does not fall back to fixture data", async () => {
    const origKey = process.env.OPENROUTER_API_KEY;

    try {
      const dbModule = await import("../src/db");
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.spyOn(dbModule, "db").mockReturnValue({
        select: () => {
          throw new Error("Connection refused (ECONNREFUSED)");
        },
      } as unknown as ReturnType<typeof dbModule.db>);
      await expect(runLiveEvaluation()).rejects.toThrow(
        /prerequisite failed: Database/i,
      );
    } finally {
      vi.restoreAllMocks();
      if (origKey !== undefined) {
        process.env.OPENROUTER_API_KEY = origKey;
      } else {
        delete process.env.OPENROUTER_API_KEY;
      }
    }
  });
});
