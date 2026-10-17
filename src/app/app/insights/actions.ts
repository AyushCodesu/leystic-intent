"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireOwnedProject } from "@/lib/owned";
import { rerankProject } from "@/lib/scoring/apply";
import { communityKey, parseScoring, type ScoringSettings } from "@/lib/scoring/weights";

/**
 * Explicit user action allowing a founder to adopt a learned community pattern
 * into their existing manual scoring preferences.
 * Adds the community to favoured communities and turns the community factor to normal if off.
 */
export async function applyCommunitySuggestionAction(
  projectId: string,
  community: string,
): Promise<void> {
  const { project } = await requireOwnedProject(projectId);
  const normalized = communityKey(community);
  if (!normalized) {
    return;
  }

  const current: ScoringSettings = parseScoring(project.scoring) ?? {
    weights: { match: "high", intent: "off", fresh: "low", community: "off" },
    communities: [],
  };

  const nextCommunities = [...new Set([...current.communities, normalized])];
  const nextWeights = { ...current.weights };
  if (nextWeights.community === "off") {
    nextWeights.community = "normal";
  }

  const nextScoring: ScoringSettings = {
    weights: nextWeights,
    communities: nextCommunities,
  };

  await db()
    .update(projects)
    .set({ scoring: nextScoring })
    .where(eq(projects.id, project.id));

  await rerankProject(project.id, nextScoring);
  revalidatePath("/app", "layout");
}

/**
 * Triggers an explicit, user-initiated website inspection.
 * Safely fetches homepage and sitemap pages up to bounds without external crawling providers.
 */
export async function inspectWebsiteAction(projectId: string): Promise<void> {
  const { project } = await requireOwnedProject(projectId);
  if (!project.url) {
    throw new Error("Project does not have a configured website URL.");
  }

  const { crawlWebsiteInventory, saveWebsiteInspection } = await import("@/lib/gaps");
  const result = await crawlWebsiteInventory(project.url);
  await saveWebsiteInspection(project.id, project.url, result);

  revalidatePath(`/app/insights`);
}

/**
 * Persists a founder's confirmation or refinement of a candidate demand-to-page mapping.
 */
export async function confirmDemandPageMappingAction(
  projectId: string,
  demandGroupId: string,
  status: "unconfirmed" | "confirmed_match" | "partial_match" | "confirmed_gap",
  confirmedPageUrl?: string | null,
  notes?: string | null,
): Promise<void> {
  const { project } = await requireOwnedProject(projectId);
  const { saveFounderConfirmation } = await import("@/lib/gaps");

  await saveFounderConfirmation(
    project.id,
    demandGroupId,
    status,
    confirmedPageUrl,
    notes,
  );

  revalidatePath(`/app/insights`);
}
