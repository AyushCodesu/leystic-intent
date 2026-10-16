"use server";

import { revalidatePath } from "next/cache";
import { failure, type ActionResult } from "@/lib/actionResult";
import { dismissAlertsOffer, turnOnDiscordAlerts, turnOnEmailAlerts } from "@/lib/alerts/offer";
import { FEED_PAGE_SIZE, feedFilter, toRow, type FeedRow } from "@/lib/feed";
import { markThreadReplied, redditLeadThread, reopenThread } from "@/lib/handled";
import { leadInSubreddit, listLeads, recordLeadOutcome, setLeadStatus } from "@/lib/leads";
import { addMute } from "@/lib/mutes";
import { promoPolicyFor } from "@/lib/reddit/skus";
import { requireOwnedProject } from "@/lib/owned";
import { sweepStatus, type SweepStatus } from "@/lib/sweep";

/** Takes a lead out of the feed without saying anything about why. */
export async function hideLeadAction(projectId: string, leadId: string) {
  await requireOwnedProject(projectId);
  await setLeadStatus(projectId, leadId, "hidden", null);
  revalidatePath("/app", "layout");
}

/**
 * The user answered the thread: it and every lead found in it later leave New,
 * the rail's count and every alert channel, and stay under Replied.
 */
export async function repliedLeadAction(projectId: string, leadId: string) {
  await requireOwnedProject(projectId);
  const thread = await redditLeadThread(projectId, leadId);
  if (thread) {
    await markThreadReplied(projectId, "reddit", thread);
    await recordLeadOutcome(projectId, leadId, "replied", null);
  }
  revalidatePath("/app", "layout");
}

/** Takes Replied back: the thread's leads are new again, and later ones arrive as before. */
export async function reopenLeadAction(projectId: string, leadId: string) {
  await requireOwnedProject(projectId);
  const thread = await redditLeadThread(projectId, leadId);
  if (thread) {
    await reopenThread(projectId, "reddit", thread);
  }
  revalidatePath("/app", "layout");
}

/** Nothing from this community again, in the feed or in any alert, until the mute is taken off. */
export async function muteSubredditAction(projectId: string, subreddit: string) {
  await requireOwnedProject(projectId);
  await addMute(projectId, "subreddit", subreddit);
  revalidatePath("/app", "layout");
}

/** Records that a lead was a miss, with the reason the user picked, or asks for one. */
export async function markNotFitAction(projectId: string, leadId: string, formData: FormData): Promise<ActionResult> {
  await requireOwnedProject(projectId);
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) {
    return { error: "Pick a reason before marking a lead as not a fit" };
  }
  await setLeadStatus(projectId, leadId, "not_fit", reason);
  await recordLeadOutcome(projectId, leadId, "not_fit", reason);
  revalidatePath("/app", "layout");
  return { error: null };
}

/** Records a user-confirmed outcome for this lead (meeting booked, opportunity, customer, etc.). */
export async function recordLeadOutcomeAction(
  projectId: string,
  leadId: string,
  formData: FormData,
): Promise<ActionResult> {
  await requireOwnedProject(projectId);
  const outcome = String(formData.get("outcome") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!outcome) {
    return { error: "Pick an outcome to record" };
  }
  await recordLeadOutcome(projectId, leadId, outcome, notes);
  revalidatePath("/app", "layout");
  return { error: null };
}

/**
 * The next page of the feed the list is already showing, read in the same
 * order it is drawn in. The filters arrive as the query string the page is on
 * and are read back through `feedFilter`, so a caller can only ask for a feed
 * the pills can ask for.
 */
export async function moreLeadsAction(
  projectId: string,
  search: string,
  offset: number,
): Promise<FeedRow[]> {
  await requireOwnedProject(projectId);
  const params = Object.fromEntries(new URLSearchParams(search));
  const page = { limit: FEED_PAGE_SIZE, offset: Math.max(0, Math.trunc(offset)) };
  const rows = await listLeads(projectId, feedFilter(params), page);
  return rows.map(toRow);
}

/** The first sweep as it stands, for the line that reports it while it runs. */
export async function sweepAction(projectId: string): Promise<SweepStatus | null> {
  await requireOwnedProject(projectId);
  return sweepStatus(projectId);
}

/**
 * The self-promotion rule of the community an opened lead sits in, read the
 * first time anybody opens one there. Only a community this project holds a
 * lead in can be asked about, so the call cannot be pointed at any subreddit
 * to spend the house's money.
 */
export async function promoPolicyAction(
  projectId: string,
  subreddit: string,
): Promise<string | null> {
  const { user } = await requireOwnedProject(projectId);
  if (!(await leadInSubreddit(projectId, subreddit))) {
    return null;
  }
  return promoPolicyFor(projectId, user.id, subreddit).catch(() => null);
}

/** The offer's "Email me daily": a daily digest to the person's own address. */
export async function emailAlertsAction(projectId: string): Promise<ActionResult> {
  const { user } = await requireOwnedProject(projectId);
  try {
    await turnOnEmailAlerts(user.id, projectId);
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/app", "layout");
  return { error: null };
}

/** The offer's Discord field: a daily post to the pasted webhook, or why that URL is not one. */
export async function discordAlertsAction(projectId: string, url: string): Promise<ActionResult> {
  const { user } = await requireOwnedProject(projectId);
  try {
    await turnOnDiscordAlerts(user.id, projectId, url);
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/app", "layout");
  return { error: null };
}

/** The offer's "Not now". */
export async function dismissAlertsOfferAction(projectId: string): Promise<ActionResult> {
  const { user } = await requireOwnedProject(projectId);
  await dismissAlertsOffer(user.id, projectId);
  revalidatePath("/app", "layout");
  return { error: null };
}
