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
