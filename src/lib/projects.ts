import { cache } from "react";
import { and, asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { deletionAuditLog, projects, users } from "@/db/schema";
import { forgetProjectFeed } from "./projectFeedCache";
import { assertAuthorizedOperator, ensureSourcePolicyFresh, type OperatorContext } from "./sourcePolicy";
import { validateDeletionReasonCode, type DeletionReasonCode } from "./retentionReason";
import { limitsFor } from "./tiers";
import { config } from "./config";
import { tierNameFor } from "./anyapi";

export type Project = typeof projects.$inferSelect;

/**
 * Read once per server render: the layout's switcher and the page under it
 * both need the list. Outside a render every call reads afresh (see
 * currentLocalUser).
 */
export const listProjects = cache(async (userId: string): Promise<Project[]> => {
  return db().select().from(projects).where(eq(projects.userId, userId)).orderBy(asc(projects.createdAt));
});

/**
 * Creates a project, refusing when the user's tier is already at its limit. The
 * count and the insert share a transaction that holds the user's row, so two
 * requests arriving together are counted one after the other, not both at once.
 */
export async function createProject(userId: string, name: string, url: string | null) {
  const limits = limitsFor(await tierNameFor(userId), config().SELF_HOSTED);
  return db().transaction(async (tx) => {
    if (limits?.projects != null) {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
      const existing = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.userId, userId));
      if (existing.length >= limits.projects) {
        throw new Error(`This tier allows ${limits.projects} projects. Connect a wallet for more.`);
      }
    }
    const rows = await tx.insert(projects).values({ userId, name, url }).returning();
    return rows[0];
  });
}

/** One project, only when it belongs to the caller. */
export async function projectForUser(userId: string, projectId: string): Promise<Project | null> {
  const rows = await db()
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.id, projectId)));
  return rows[0] ?? null;
}

/** The project the screen is showing: the one asked for, else the first. */
export async function activeProject(userId: string, requested?: string): Promise<Project | null> {
  return pickProject(await listProjects(userId), requested);
}

/** activeProject over a list already in hand. */
export function pickProject(all: Project[], requested?: string): Project | null {
  return all.find((project) => project.id === requested) ?? all[0] ?? null;
}

/**
 * The project a page about one project shows. An account with no project has
 * one thing to do, so every such page takes it there: this is where a new
 * signup lands, and an empty page telling them to go and find the button was
 * the whole of their welcome.
 */
export async function requireActiveProject(userId: string, requested?: string): Promise<Project> {
  const project = await activeProject(userId, requested);
  if (!project) {
    redirect("/app/projects/new");
  }
  return project;
}

/**
 * Deletes a customer's project and cascades all project-associated records.
 * Leaves shared multi-tenant records (reddit_posts, reddit_authors, search_runs) intact
 * so other customers' independent tracking is never affected.
 * Idempotent: repeated calls cleanly return notFound: true without errors.
 * Auditable: records action without retaining personal or provider content in the audit log.
 */
export async function deleteProject(
  userId: string,
  projectId: string,
  options: { operatorContext?: OperatorContext; reason?: DeletionReasonCode | string } = {},
): Promise<{ deleted: boolean; notFound?: boolean; projectId: string }> {
  let isOperator = false;
  let actor = userId;
  let actorRole = "project_owner";
  if (options.operatorContext) {
    await ensureSourcePolicyFresh();
    const verified = assertAuthorizedOperator(options.operatorContext);
    isOperator = true;
    actor = verified.operatorId;
    actorRole = verified.role;
  }

  return db().transaction(async (tx) => {
    const existing = await tx
      .select({ id: projects.id, userId: projects.userId })
      .from(projects)
      .where(
        isOperator
          ? eq(projects.id, projectId)
          : and(eq(projects.id, projectId), eq(projects.userId, userId)),
      )
      .for("update");

    if (existing.length === 0) {
      return { deleted: false, notFound: true, projectId };
    }

    // Cascade deletion of all project-scoped tables in PostgreSQL
    await tx.delete(projects).where(eq(projects.id, projectId));

    const defaultReason: DeletionReasonCode = isOperator ? "OPERATOR_DELETION" : "USER_REQUEST";
    await tx.insert(deletionAuditLog).values({
      action: "DELETE_PROJECT",
      actor,
      actorRole,
      targetType: "project",
      targetId: projectId,
      outcome: "SUCCESS",
      reasonCode: validateDeletionReasonCode(options.reason, defaultReason),
      details: {
        isOperator,
        projectOwnerId: existing[0].userId,
      },
    });

    forgetProjectFeed(projectId);

    return { deleted: true, projectId };
  });
}
