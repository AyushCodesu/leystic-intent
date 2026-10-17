"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { moreLeadsAction } from "@/app/app/leads/actions";
import { LeadRow } from "@/components/leads/LeadRow";
import { entryHref } from "@/components/leads/workspace";
import { Skeleton } from "@/components/Skeleton";
import { VerdictBadge } from "@/components/VerdictBadge";
import { FEED_PAGE_SIZE, type FeedRow } from "@/lib/feed";

type LeadPagesProps = {
  projectId: string;
  /** The filters this list is showing, as the URL spells them. */
  search: string;
  /** The first page, read on the server, which is where the next page starts. */
  initialRows: FeedRow[];
  /** Every lead these filters hold, so the list knows when it is whole. */
  total: number;
  selectedId: string | null;
};

/**
 * The feed's list, a page at a time as it is scrolled.
 *
 * The server reads the first page and stops, because a project with a year of
 * backfill behind it holds hundreds of leads and reading and drawing all of
 * them is the whole of the wait before anything appears. Everything after that
 * is fetched when the foot of the list comes into view, so the wait is one page
 * long however many leads there are.
 */
export function LeadPages({ projectId, search, initialRows, total, selectedId }: LeadPagesProps) {
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [failed, setFailed] = useState(false);
  const foot = useRef<HTMLDivElement | null>(null);
  const fetching = useRef(false);
  /** The count these pages were read against, so a change in it is noticed. */
  const counted = useRef(total);
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search]);
  const drawn = initialRows.length;
  const shown = drawn + rows.length;
  const whole = shown >= total;
  const held = rows.length;

  const more = useCallback(async () => {
    if (fetching.current) {
      return;
    }
    fetching.current = true;
    setFailed(false);
    try {
      const next = await moreLeadsAction(projectId, search, shown);
      setRows((before) => [...before, ...next]);
    } catch {
      setFailed(true);
    } finally {
      fetching.current = false;
    }
  }, [projectId, search, shown]);

  /**
   * Hiding a lead or marking it a miss takes it out of the feed, and the
   * server draws its own page again. The pages this holds are not redrawn with
   * it, so a row that has left the feed would sit there until a filter moved;
   * a count that has changed is how that is known, and the pages held are read
   * again from where the server's page ends.
   */
  useEffect(() => {
    if (counted.current === total) {
      return;
    }
    counted.current = total;
    const pages = Math.ceil(held / FEED_PAGE_SIZE);
    if (pages === 0 || fetching.current) {
      return;
    }
    let live = true;
    fetching.current = true;
    void (async () => {
      try {
        const fresh: FeedRow[] = [];
        for (let page = 0; page < pages; page += 1) {
          fresh.push(...(await moreLeadsAction(projectId, search, drawn + page * FEED_PAGE_SIZE)));
        }
        if (live) {
          setRows(fresh);
        }
      } catch {
        // What is on screen is one lead out of date, which is better than
        // emptying a list the reader is in the middle of.
      } finally {
        fetching.current = false;
      }
    })();
    return () => {
      live = false;
    };
  }, [drawn, held, projectId, search, total]);

  useEffect(() => {
    const mark = foot.current;
    if (!mark || whole || failed) {
      return;
    }
    // The list column is its own scroller, so the foot only meets the viewport
    // once the rows above it have been read.
    const watch = new IntersectionObserver((seen) => {
      if (seen.some((one) => one.isIntersecting)) {
        void more();
      }
    });
    watch.observe(mark);
    return () => watch.disconnect();
  }, [failed, more, whole]);

  // The server's page and the ones fetched after it are one list, so a row
  // that carries on the thread above it is nested across a page's edge too.
  // A lead that leaves the feed pulls the next one up into the server's page
  // before the pages held are read again; it is drawn there and not twice.
  const first = new Set(initialRows.map((row) => row.id));
  const listed = [...initialRows, ...rows.filter((row) => !first.has(row.id))];

  return (
    <>
      {listed.map((row, index) => (
        <LeadRow
          key={row.id}
          id={row.id}
          href={entryHref(params, row.id)}
          selected={row.id === selectedId}
          title={row.title}
          excerpt={row.excerpt}
          nested={index > 0 && listed[index - 1].postId === row.postId}
          author={row.author}
          avatarUrl={row.avatarUrl}
          subreddit={row.subreddit}
          subredditIconUrl={row.subredditIconUrl}
          createdAt={row.createdAt}
          trailing={<VerdictBadge fit={row.fit} intent={row.intent} />}
          learnedTier={row.learnedTier}
          learnedExplanation={row.learnedExplanation}
        />
      ))}
      {whole ? null : (
        <div ref={foot} className="flex items-center gap-2.5 border-t px-3 py-2.5">
          {failed ? (
            <button type="button" className="text-small text-fg-muted underline" onClick={more}>
              {`Could not read the other ${total - shown}. Try again`}
            </button>
          ) : (
            <>
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-full max-w-64" />
                <Skeleton className="h-3 w-32" />
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
