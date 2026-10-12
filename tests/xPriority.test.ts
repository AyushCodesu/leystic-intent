import { describe, expect, it } from "vitest";
import { expectedXIntent, rankXOpportunities, xPriority } from "@/lib/x/priority";
import { xQuestions } from "@/lib/x/questions";

const noul = (noul: number) => ({ type: "noul", noul });
const signals = (over: Record<string, unknown> = {}) => ({
  own_need: noul(0.95), same_kind: noul(0.9),
  intent: { type: "score", score: 3.1 }, rival_vendor: noul(0.05), promoting: noul(0.05), resolved: noul(0.05),
  hard_requirement: { type: "choice", choice: "none_stated" }, ...over,
});

describe("cached X attention priority", () => {
  it("reads only answers the X judge stores, at either level, plus the pipeline's reply check", () => {
    const read = new Set<string>();
    const spy = new Proxy(signals({ founder_would_reply: noul(0.9), reply: { worth_reply: true } }), {
      get(target, key, receiver) {
        if (typeof key === "string") read.add(key);
        return Reflect.get(target, key, receiver);
      },
    });
    xPriority({ signals: spy, level: "complete", replyVerdictCode: "worth_reply" });
    // reply is written by run.ts's reply check (signals.reply), not asked as a question.
    read.delete("reply");
    expect(read.size).toBeGreaterThan(0);
    for (const complete of [false, true]) {
      const asked = Object.keys(xQuestions(["s0"], { complete, brief: null }));
      expect([...read].filter((key) => !asked.includes(key))).toEqual([]);
    }
  });

  it("uses graded intent when available and the raw score when the gateway omits distributions", () => {
    expect(expectedXIntent({ type: "score", score: 3, probabilities: { 2: 0.4, 3: 0.6 } })).toBeCloseTo(2.6);
    expect(expectedXIntent({ type: "score", score: 2.83 })).toBe(2.83);
    expect(expectedXIntent({ type: "score", score: 2.83, probabilities: { bad: 1 } })).toBe(2.83);
    expect(expectedXIntent({ type: "score", score: 2.83, probabilities: { 4: 0.2 } })).toBe(2.83);
    expect(expectedXIntent({ type: "score", score: Infinity })).toBeNull();
  });

  it("does not invent a priority from missing or invalid evidence", () => {
    for (const value of [null, [], "a score", signals({ own_need: noul(NaN) }), signals({ intent: null })]) {
      expect(xPriority({ signals: value, level: "complete" }).priority).toBeNull();
    }
  });

  it("keeps unknown context without a commercial-use penalty", () => {
    const basic = signals();
    const complete = xPriority({ signals: basic, level: "complete" });
    const unknown = xPriority({ signals: { ...basic, hard_requirement: { type: "choice", choice: "unknown" } }, level: "search" });
    expect(unknown.priority).toBe(complete.priority);
    expect(unknown.checks).toEqual(["Check author and context", "Check requirements"]);
    expect(complete.priority).toBeGreaterThan(0.4);
  });

  it("demotes promotions, solved needs and unmet requirements despite high intent/fit", () => {
    const good = xPriority({ signals: signals(), level: "complete" }).priority!;
    for (const over of [
      { rival_vendor: noul(0.99) }, { promoting: noul(0.99) }, { resolved: noul(0.99) },
      { hard_requirement: { type: "choice", choice: "unmet" } },
    ]) expect(xPriority({ signals: signals(over), level: "complete" }).priority!).toBeLessThan(good / 2);
  });

  it("retains checked public reply venues without treating an unverified high reply signal as enough", () => {
    const venue = signals({ own_need: noul(0), promoting: noul(0.9), founder_would_reply: noul(0.98) });
    expect(xPriority({ signals: venue, level: "search" }).priority).toBe(0);
    expect(xPriority({ signals: { ...venue, reply: { worth_reply: true } }, level: "search" }).priority).toBe(0);
    expect(xPriority({ signals: { ...venue, reply: { worth_reply: true } }, level: "search", replyVerdictCode: "worth_reply" }).priority).toBeGreaterThan(0.4);
  });

  it("a failed public-reply assessment does not erase an independent adoption/investigation opportunity", () => {
    const base = xPriority({ signals: signals(), level: "complete" });
    for (const reply of [{ worth_reply: false }, { worth_reply: true, code: "not_reply_worthy" }]) {
      const failed = xPriority({ signals: signals({ reply }), level: "complete", replyVerdictCode: "worth_reply" });
      expect(failed.priority).toBe(base.priority);
      expect(failed.conversationPriority).toBeNull();
      expect(failed.checks).toContain("Public reply not recommended");
    }
  });

  it("ranks a completed conversation independently of missing buyer-only signals, but not missing conversation evidence", () => {
    const raw = signals({ own_need: null, intent: null, promoting: null, resolved: null, founder_would_reply: noul(0.98), reply: { worth_reply: true } });
    const verified = { signals: raw, level: "search", replyVerdictCode: "worth_reply" };
    const result = xPriority(verified);
    expect(result.needPriority).toBeNull();
    expect(result.priority).toBeGreaterThan(0.4);
    expect(result.checks).toContain("Adoption assessment incomplete");
    expect(xPriority({ ...verified, replyVerdictCode: undefined }).priority).toBeNull();
    expect(xPriority({ ...verified, signals: { ...raw, founder_would_reply: null } }).priority).toBeNull();
    expect(xPriority({ ...verified, signals: { ...raw, rival_vendor: null } }).priority).toBeNull();
    expect(xPriority({ ...verified, signals: { ...raw, same_kind: null } }).priority).toBeNull();
    expect(xPriority({ ...verified, signals: { ...raw, reply: { worth_reply: false } } }).priority).toBeNull();
    expect(xPriority({ ...verified, signals: { ...raw, reply: { worth_reply: true, code: "not_reply_worthy" } } }).priority).toBeNull();
    expect(xPriority({ ...verified, signals: { ...raw, reply: { worth_reply: true, code: "unexpected" } } }).priority).toBeNull();
    expect(xPriority({ ...verified, signals: { ...raw, founder_would_reply: noul(0) } }).priority).toBe(0);
    expect(xPriority({ ...verified, signals: { ...raw, hard_requirement: { type: "choice", choice: "unmet" } } }).conversationPriority).toBeCloseTo(result.conversationPriority! * 0.2);
    expect(xPriority({ ...verified, signals: { ...raw, own_need: noul(0.9) } }).checks).toContain("Adoption assessment incomplete");
  });

  it("labels no extracted requirements as unverified fit without inventing a constraint or score penalty", () => {
    const none = xPriority({ signals: signals(), level: "complete" });
    const unknown = xPriority({ signals: signals({ hard_requirement: { type: "choice", choice: "unknown" } }), level: "complete" });
    expect(none.checks).not.toContain("Check product fit");
    expect(none.notes).toEqual(["No specific requirement identified. Product compatibility is unverified."]);
    expect(none.priority).toBe(unknown.priority);
    for (const hard_requirement of [{ type: "choice" }, { type: "choice", choice: "bad" }, { type: "choice", choice: ["met"] }]) {
      expect(xPriority({ signals: signals({ hard_requirement }), level: "complete" }).checks).toContain("Check requirements");
    }
  });

  it("ranks before author dedupe, keeps unknown scores last, and keeps every history post", () => {
    const input = (key: string, author: string, raw: unknown, newer = false) => ({
      key, author, signals: raw, postedAt: new Date(newer ? "2026-10-09" : "2026-10-02"), level: "complete", engagement: 3,
    });
    const rows = [input("newerWeak", "SAME", signals({ own_need: noul(0.2) }), true), input("olderAsk", "same", signals()), input("unscored", "other", null, true)];
    expect(rankXOpportunities(rows).map((x) => x.key)).toEqual(["olderAsk", "unscored"]);
    expect(rankXOpportunities(rows, false)).toHaveLength(3);
  });
});
