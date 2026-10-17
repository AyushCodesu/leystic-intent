import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  demandPageConfirmations,
  leads,
  redditComments,
  redditPosts,
  websiteInspections,
  websitePages,
} from "@/db/schema";
import { LEAD_SAMPLE_LIMIT } from "./constants";
import { aggregateDemandFromLeads } from "./demand";
import { matchDemandToPages } from "./matching";
import { buildDemandGapCandidates } from "./prioritization";
import type {
  DemandGapCandidate,
  FounderConfirmation,
  FounderConfirmationStatus,
  InspectedPage,
  PageInventoryResult,
  WebsiteInspectionSnapshot,
} from "./types";

/**
 * Persists a completed website inspection and its crawled pages.
 * Preserves historical records so previous snapshots remain available.
 */
export async function saveWebsiteInspection(
  projectId: string,
  rootUrl: string,
  result: PageInventoryResult,
): Promise<string> {
  const [inspection] = await db()
    .insert(websiteInspections)
    .values({
      projectId,
      rootUrl,
      status: result.status,
      pagesFound: result.pagesFound,
      pagesCrawled: result.pagesCrawled,
      hasSitemap: result.sitemapFound,
      error: result.error,
      finishedAt: new Date(),
    })
    .returning();

  if (result.status !== "failed" && result.pages.length > 0) {
    await db()
      .insert(websitePages)
      .values(
        result.pages.map((p) => ({
          projectId,
          inspectionId: inspection.id,
          url: p.url,
          canonicalUrl: p.canonicalUrl,
          title: p.title,
          description: p.description,
          h1: p.h1,
          headings: p.headings,
          path: p.path,
          crawledAt: p.crawledAt,
        })),
      );
  }

  return inspection.id;
}

/**
 * Retrieves the latest successful or partial inspection snapshot for a project.
 * If the latest attempt failed, reports the error while returning pages from the previous successful snapshot.
 */
export async function getLatestInspectionSnapshot(
  projectId: string,
): Promise<WebsiteInspectionSnapshot> {
  const allInspections = await db()
    .select()
    .from(websiteInspections)
    .where(eq(websiteInspections.projectId, projectId))
    .orderBy(desc(websiteInspections.startedAt))
    .limit(5);

  if (allInspections.length === 0) {
    return {
      inspectionId: null,
      status: "not_inspected",
      inspectedAt: null,
      rootUrl: null,
      pagesCount: 0,
      pages: [],
      error: null,
    };
  }

  const latest = allInspections[0];
  const lastWorking = allInspections.find((i) => i.status === "success" || i.status === "partial");

  if (!lastWorking) {
    return {
      inspectionId: latest.id,
      status: "failed",
      inspectedAt: latest.finishedAt ? latest.finishedAt.toISOString() : latest.startedAt.toISOString(),
      rootUrl: latest.rootUrl,
      pagesCount: 0,
      pages: [],
      error: latest.error || "Inspection failed",
    };
  }

  const storedPages = await db()
    .select()
    .from(websitePages)
    .where(eq(websitePages.inspectionId, lastWorking.id));

  const pages: InspectedPage[] = storedPages.map((p) => ({
    url: p.url,
    canonicalUrl: p.canonicalUrl,
    title: p.title,
    description: p.description,
    h1: p.h1,
    headings: p.headings ?? [],
    path: p.path,
    crawledAt: p.crawledAt,
  }));

  const inspectionError = latest.status === "failed" ? latest.error : null;

  return {
    inspectionId: lastWorking.id,
    status: lastWorking.status as "success" | "partial",
    inspectedAt: lastWorking.finishedAt ? lastWorking.finishedAt.toISOString() : lastWorking.startedAt.toISOString(),
    rootUrl: lastWorking.rootUrl,
    pagesCount: pages.length,
    pages,
    error: inspectionError,
  };
}

/**
 * Loads all founder-recorded demand-to-page confirmations for a project.
 */
export async function getFounderConfirmations(
  projectId: string,
): Promise<Map<string, FounderConfirmation>> {
  const rows = await db()
    .select()
    .from(demandPageConfirmations)
    .where(eq(demandPageConfirmations.projectId, projectId));

  const map = new Map<string, FounderConfirmation>();
  for (const row of rows) {
    map.set(row.demandGroupId, {
      status: row.status as FounderConfirmationStatus,
      confirmedPageUrl: row.confirmedPageUrl,
      notes: row.notes,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : "",
    });
  }
  return map;
}

/**
 * Upserts a founder confirmation for a demand group mapping.
 */
export async function saveFounderConfirmation(
  projectId: string,
  demandGroupId: string,
  status: FounderConfirmationStatus,
  confirmedPageUrl?: string | null,
  notes?: string | null,
): Promise<void> {
  await db()
    .insert(demandPageConfirmations)
    .values({
      projectId,
      demandGroupId,
      status,
      confirmedPageUrl: confirmedPageUrl ?? null,
      notes: notes ?? null,
      confirmedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [demandPageConfirmations.projectId, demandPageConfirmations.demandGroupId],
      set: {
        status,
        confirmedPageUrl: confirmedPageUrl ?? null,
        notes: notes ?? null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Top-level query returning the candidate demand-to-page gaps for a project.
 */
export async function getProjectDemandGaps(projectId: string): Promise<{
  candidates: DemandGapCandidate[];
  inspection: WebsiteInspectionSnapshot;
  hasLeads: boolean;
}> {
  // 1. Fetch bounded leads for project
  const leadRows = await db()
    .select({
      id: leads.id,
      postId: leads.postId,
      title: redditPosts.title,
      body: redditPosts.body,
      matchedPhrase: leads.matchedPhrase,
      stage: leads.stage,
      reason: leads.reason,
      outcome: leads.outcome,
      url: redditPosts.url,
      commentPermalink: redditComments.permalink,
      subreddit: redditPosts.subreddit,
      foundAt: leads.foundAt,
    })
    .from(leads)
    .leftJoin(redditPosts, eq(leads.postId, redditPosts.id))
    .leftJoin(redditComments, eq(leads.commentId, redditComments.id))
    .where(eq(leads.projectId, projectId))
    .orderBy(desc(leads.foundAt), desc(leads.id))
    .limit(LEAD_SAMPLE_LIMIT);

  const hasLeads = leadRows.length > 0;
  if (!hasLeads) {
    const inspection = await getLatestInspectionSnapshot(projectId);
    return {
      candidates: [],
      inspection,
      hasLeads: false,
    };
  }

  // 2. Aggregate demand groups
  const demandGroups = aggregateDemandFromLeads(leadRows);

  // 3. Load latest inspection snapshot
  const inspection = await getLatestInspectionSnapshot(projectId);

  // 4. Perform deterministic matching
  const matchResults = matchDemandToPages(demandGroups, inspection.pages, inspection.status);

  // 5. Load founder confirmations
  const confirmations = await getFounderConfirmations(projectId);

  // 6. Build prioritized candidate gaps
  const candidates = buildDemandGapCandidates(demandGroups, matchResults, confirmations, inspection);

  return {
    candidates,
    inspection,
    hasLeads: true,
  };
}
