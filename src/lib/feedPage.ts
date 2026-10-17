import { FEED_PAGE_SIZE } from "./feed";
import { countLeads, feedFacets, listLeadFaces, listLeads, listReviewItems } from "./leads";
import { readProjectFeed } from "./projectFeedCache";
import { scanReport, type ScanReport } from "./scan/report";

import type { FeedFacets, FeedFilter, LeadFace, ReviewItem } from "./feed";
import type { FeedLead } from "./leads";

/**
 * Everything the leads page reads that one set of filter pills decides, which
 * is everything it draws except what the project is doing and which lead the
 * URL names.
 */
export type FeedPageReads = {
  /** The first page of the feed, in the feed's own order. */
  rows: FeedLead[];
  /** How many leads the filter holds in all, which the list column counts. */
  total: number;
  faces: LeadFace[];
  facets: FeedFacets;
  review: ReviewItem[];
  report: ScanReport;
  /**
   * How many leads this project holds over the whole of time, counted only when
   * the window it is being read under holds none and has one to explain. The
   * first sweep reaches back a year, so an empty window is not an empty project.
   */
  elsewhere: number;
  /**
   * Whether this is the whole of time read in place of the window asked for,
   * which only a window nobody picked can be (see feedPage). The page draws
   * its pills as days=all when it is.
   */
  widened: boolean;
};

/**
 * The filter this read answers, as one value the next read can be compared to.
 * A window nobody picked is its own key: it can open on the whole of time,
 * which the same 30 days picked by hand never does.
 */
function filterKey(filter: FeedFilter, widenable: boolean): string {
  return JSON.stringify([
    filter.status,
    filter.days,
    filter.subreddit ?? null,
    filter.stage ?? null,
    filter.theme ?? null,
    filter.at ?? null,
    filter.order ?? "score",
    widenable,
  ]);
}

async function readFeedPage(projectId: string, filter: FeedFilter): Promise<Omit<FeedPageReads, "widened">> {
  const [rows, total, faces, facets, review, report] = await Promise.all([
    listLeads(projectId, filter, { limit: FEED_PAGE_SIZE, offset: 0 }),
    countLeads(projectId, filter),
    listLeadFaces(projectId, filter),
    feedFacets(projectId),
    listReviewItems(projectId, filter.days, filter.at),
    scanReport(projectId, filter.days),
  ]);
  // The whole of time, and the whole of it: the slice a strip column picked is
  // dropped with the window, or the count offered as "in all time" would still
  // be one day of it.
  const elsewhere =
    total === 0 && filter.status === "new" && (filter.days !== "all" || filter.at)
      ? await countLeads(projectId, { ...filter, days: "all", at: undefined })
      : 0;
  return { rows, total, faces, facets, review, report, elsewhere };
}

/**
 * Nobody picked the 30 days the feed opens on. A first sweep reads a year, and
 * its leads are mostly older than a month, so a new project opened on an empty
 * window with its leads one pill away. When the window nobody chose is empty
 * and the year is not, the feed opens on the year.
 */
async function readOpening(projectId: string, filter: FeedFilter, widenable: boolean): Promise<FeedPageReads> {
  const page = await readFeedPage(projectId, filter);
  if (!widenable || page.total > 0 || page.elsewhere === 0) {
    return { ...page, widened: false };
  }
  return { ...(await readFeedPage(projectId, { ...filter, days: "all", at: undefined })), widened: true };
}

/**
 * The leads page's reads, answered from what this project last read when the
 * filter has not moved. Every writer of what is read here drops that answer, so
 * the only thing this skips is a repeat of a read whose result cannot have
 * changed - which is what selecting a lead asks for.
 *
 * `widenable` says the window was nobody's choice, so an empty one may open on
 * the whole of time instead. Both reads are held under the key the page asked
 * by, so the next render of that same URL is answered from the one entry.
 *
 * Only the first page is held. The pages the list fetches as it is scrolled ask
 * for their own offsets and are not a repeat of anything.
 */
export function feedPage(projectId: string, filter: FeedFilter, widenable = false): Promise<FeedPageReads> {
  return readProjectFeed(projectId, filterKey(filter, widenable), () => readOpening(projectId, filter, widenable));
}
