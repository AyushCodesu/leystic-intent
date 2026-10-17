import { describe, expect, it } from "vitest";
import { runEvaluation, verifyThreadDeduplication } from "../scripts/eval-competitor-reasons";

describe("competitor reasons held-out real-world evaluation", () => {
  const metrics = runEvaluation();
  const dedup = verifyThreadDeduplication();

  it("evaluates a held-out dataset across multiple competitors and edge cases", () => {
    expect(metrics.sampleSize).toBe(28);
    // Explicit switching intent should maintain high precision
    expect(metrics.switching.precision).toBeGreaterThanOrEqual(0.85);
    expect(metrics.switching.recall).toBeGreaterThanOrEqual(0.85);
  });

  it("never falsely alarms on users who explicitly intend to stay", () => {
    // Users with compliance or API lock-in must never be flagged as potential switchers
    expect(metrics.edgeCaseAnalysis.stayingIntentFalsePositiveRate).toBe(0.0);
  });

  it("accurately records and bounds real-world edge case errors (sarcasm and mixed sentiment)", () => {
    // Sarcasm and mixed sentiment are known realistic edge-case challenges in production NLP
    expect(metrics.edgeCaseAnalysis.sarcasmErrorRate).toBeGreaterThan(0.0);
    expect(metrics.edgeCaseAnalysis.mixedSentimentErrorRate).toBeGreaterThan(0.0);
    // Overall reason accuracy on real-world edge cases remains robust (> 80%)
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
});
