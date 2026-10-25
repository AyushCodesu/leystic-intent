import { afterEach, beforeEach, expect, it } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { describeDb, makePost, makeProject, makeUser } from "./fixtures/db";
import { db } from "@/db";
import { competitorMentions, projectCompetitors } from "@/db/schema";
import { listMentions } from "@/lib/competitors/read";

describeDb("competitor reasons database persistence and tenant isolation", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("reddit");
    cleanupAuth = auth.cleanup;
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });
  it("persists reason category, switching evidence, and grounded explanation with strict tenant isolation", async () => {
    const user = await makeUser();
    const projectA = await makeProject(user.id, { name: "Project Alpha" });
    const projectB = await makeProject(user.id, { name: "Project Beta" });

    // Both projects watch Typeform
    await db()
      .insert(projectCompetitors)
      .values([
        { projectId: projectA.id, name: "Typeform", state: "active" },
        { projectId: projectB.id, name: "Typeform", state: "active" },
      ]);

    const post1 = await makePost({ title: "Migrating off Typeform" });
    const post2 = await makePost({ title: "Older unclassified mention" });
    const postB = await makePost({ title: "Project B thread" });

    // Project A: one enriched mention, one legacy mention with null reason fields
    await db()
      .insert(competitorMentions)
      .values([
        {
          projectId: projectA.id,
          competitor: "Typeform",
          postId: post1.id,
          sentiment: "negative",
          summary: "Leaving Typeform due to price increase",
          quote: "Migrating off Typeform",
          reasonCategory: "pricing_value",
          switchingEvidence: "actively_switching",
          explanation: "Author is migrating off Typeform due to price hikes",
        },
        {
          projectId: projectA.id,
          competitor: "Typeform",
          postId: post2.id,
          sentiment: "neutral",
          summary: "Just mentioned",
          quote: null,
          reasonCategory: null,
          switchingEvidence: null,
          explanation: null,
        },
      ]);

    // Project B: own mention
    await db()
      .insert(competitorMentions)
      .values([
        {
          projectId: projectB.id,
          competitor: "Typeform",
          postId: postB.id,
          sentiment: "positive",
          summary: "Project B feedback",
          reasonCategory: "usability",
          switchingEvidence: "positive_recommendation",
          explanation: "Project B user likes usability",
        },
      ]);

    // Query Project A mentions
    const mentionsA = await listMentions(projectA.id);
    expect(mentionsA).toHaveLength(2);

    const enriched = mentionsA.find((m) => m.postId === post1.id);
    expect(enriched).toBeDefined();
    expect(enriched?.reasonCategory).toBe("pricing_value");
    expect(enriched?.switchingEvidence).toBe("actively_switching");
    expect(enriched?.explanation).toBe("Author is migrating off Typeform due to price hikes");

    // Legacy backward compatibility: null values handled safely
    const legacy = mentionsA.find((m) => m.postId === post2.id);
    expect(legacy).toBeDefined();
    expect(legacy?.reasonCategory).toBeNull();
    expect(legacy?.switchingEvidence).toBeNull();
    expect(legacy?.explanation).toBeNull();

    // Query Project B mentions (tenant isolation check)
    const mentionsB = await listMentions(projectB.id);
    expect(mentionsB).toHaveLength(1);
    expect(mentionsB[0].postId).toBe(postB.id);
    expect(mentionsB[0].reasonCategory).toBe("usability");

    // Project A mentions must never leak into Project B
    const leakedPostIds = mentionsB.map((m) => m.postId);
    expect(leakedPostIds).not.toContain(post1.id);
    expect(leakedPostIds).not.toContain(post2.id);
  });
});
