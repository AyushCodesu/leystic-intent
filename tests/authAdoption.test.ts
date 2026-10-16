import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { describeDb } from "./fixtures/db";

/**
 * Moving Clerk instances gives every person a new Clerk id. Their verified
 * email is what ties the new id to the row that owns their projects.
 */

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => null }));

const { localUserFor } = await import("@/lib/auth");

const address = () => `${randomUUID()}@adoption.test`;

describeDb("localUserFor", () => {
  it("hands the existing row to a new Clerk id with the same verified email", async () => {
    const email = address();
    const before = await localUserFor({ clerkUserId: `old_${randomUUID()}`, email, emailVerified: true });
    const newId = `new_${randomUUID()}`;
    const after = await localUserFor({ clerkUserId: newId, email: email.toUpperCase(), emailVerified: true });
    expect(after?.id).toBe(before?.id);
    expect(after?.clerkUserId).toBe(newId);
    const rows = await db().select().from(users).where(eq(users.id, before!.id));
    expect(rows).toHaveLength(1);
  });

  it("never adopts on an unverified email", async () => {
    const email = address();
    const owner = await localUserFor({ clerkUserId: `old_${randomUUID()}`, email, emailVerified: true });
    const stranger = await localUserFor({ clerkUserId: `new_${randomUUID()}`, email, emailVerified: false });
    expect(stranger?.id).not.toBe(owner?.id);
    const still = await db().select().from(users).where(eq(users.id, owner!.id));
    expect(still[0].clerkUserId).toBe(owner!.clerkUserId);
  });

  it("returns the same row for a Clerk id it already knows", async () => {
    const email = address();
    const clerkUserId = `known_${randomUUID()}`;
    const first = await localUserFor({ clerkUserId, email, emailVerified: true });
    const second = await localUserFor({ clerkUserId, email, emailVerified: true });
    expect(second?.id).toBe(first?.id);
  });

  it("follows an address changed in Clerk on a row it already knows", async () => {
    const clerkUserId = `known_${randomUUID()}`;
    const first = await localUserFor({ clerkUserId, email: address(), emailVerified: true });
    const moved = address();
    const second = await localUserFor({ clerkUserId, email: moved, emailVerified: true });
    expect(second?.id).toBe(first?.id);
    expect(second?.email).toBe(moved);
    const rows = await db().select().from(users).where(eq(users.id, first!.id));
    expect(rows[0].email).toBe(moved);
  });
});
