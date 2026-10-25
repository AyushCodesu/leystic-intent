import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installTestAuthorizedSource } from "./fixtures/auth";
import { describeDb, makeProject, makeUser } from "./fixtures/db";

/**
 * A run row has to exist before its results can point at it, so there is a
 * moment when the run is stored and its results are not. Nobody may be handed
 * the run in that moment, and two callers who both missed buy it once.
 */
describeDb("a shared fetch still being stored", () => {
  let cleanupAuth: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const auth = await installTestAuthorizedSource("reddit");
    cleanupAuth = auth.cleanup;
  });

  afterEach(async () => {
    await cleanupAuth?.();
  });
  async function fixture() {
    const { db } = await import("@/db");
    const { searchRuns, users } = await import("@/db/schema");
    const { fetchShared } = await import("@/lib/reddit/fetch");
    const { eq } = await import("drizzle-orm");
    const user = await makeUser();
    const project = await makeProject(user.id, { name: "Race" });
    const query = `race test ${randomUUID()}`;
    const funded = {
      funding: `wallet:${user.id}` as const,
      call: async <T>(fn: () => Promise<T>) => ({ result: await fn(), requestId: null }),
    };
    const ctx = {
      projectId: project.id,
      funded: funded as unknown as Parameters<typeof fetchShared>[0]["ctx"]["funded"],
      maxAgeMs: 60 * 60 * 1000,
    };
    const cleanup = async () => {
      await db().delete(users).where(eq(users.id, user.id));
      await db().delete(searchRuns).where(eq(searchRuns.normalizedQuery, query));
    };
    return { ctx, query, fetchShared, cleanup, db, searchRuns, eq };
  }

  it("hands a second caller the stored results, never the half-written run", async () => {
    const { ctx, query, fetchShared, cleanup } = await fixture();
    let open!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const storing = new Promise<void>((resolve) => (reached = resolve));
    let stored: string[] = [];
    let calls = 0;
    const input = {
      ctx,
      kind: "serp" as const,
      sku: "google.search",
      normalizedQuery: query,
      run: async () => {
        calls += 1;
        return { data: ["real lead"], costUsd: 0.001 };
      },
      store: async (data: unknown) => {
        reached();
        await gate;
        stored = data as string[];
        return stored;
      },
      load: async () => stored,
    };
    try {
      const first = fetchShared(input);
      await storing;
      const second = fetchShared(input);
      open();
      expect((await first).value).toEqual(["real lead"]);
      expect(await second).toMatchObject({ value: ["real lead"], reused: true, costUsd: 0 });
      expect(calls).toBe(1);
    } finally {
      open();
      await cleanup();
    }
  });

  it("never reuses a run whose store failed, and still records what it cost", async () => {
    const { ctx, query, fetchShared, cleanup, db, searchRuns, eq } = await fixture();
    let calls = 0;
    const input = (fail: boolean) => ({
      ctx,
      kind: "serp" as const,
      sku: "google.search",
      normalizedQuery: query,
      run: async () => {
        calls += 1;
        return { data: ["real lead"], costUsd: 0.001 };
      },
      store: async (data: unknown) => {
        if (fail) {
          throw new Error("disk full");
        }
        return data as string[];
      },
      load: async () => [] as string[],
    });
    try {
      await expect(fetchShared(input(true))).rejects.toThrow("disk full");
      const again = await fetchShared(input(false));
      expect(again).toMatchObject({ value: ["real lead"], reused: false });
      expect(calls).toBe(2);
      const runs = await db().select().from(searchRuns).where(eq(searchRuns.normalizedQuery, query));
      expect(runs.map((run) => run.completedAt !== null).sort()).toEqual([false, true]);
    } finally {
      await cleanup();
    }
  });
});
