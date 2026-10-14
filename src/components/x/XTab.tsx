import Link from "next/link";
import { openXAction, scanXNowAction } from "@/app/app/x/actions";
import { PaidButton } from "@/components/PaidButton";
import { ListSkeleton } from "@/components/Skeleton";
import { StartOnOpen } from "@/components/StartOnOpen";
import { LeadWorkspace } from "@/components/leads/LeadWorkspace";
import { OpeningProvider } from "@/components/leads/opening";
import { PeopleStrip } from "@/components/leads/PeopleStrip";
import { Fleeting } from "@/components/Fleeting";
import { ScanDone, ScanRunning } from "@/components/leads/ScanBanner";
import { XFilters } from "@/components/x/XFilters";
import { GroupSummary, XSearches } from "@/components/x/XGroups";
import { XGroupDetails } from "@/components/x/XGroupDetails";
import { XOpportunityList } from "@/components/x/XOpportunityList";
import { XLeadDetail, type XSelection } from "@/components/x/XLeadDetail";
import { config } from "@/lib/config";
import { atBounds, atKey, grainOf, type FeedParams } from "@/lib/feed";
import { errorSentence, relativeAge, relativeUntil } from "@/lib/format";
import { limitsForUser } from "@/lib/tier";
import { DAY_MS } from "@/lib/time";
import { QUIET_RECHECK_DAYS } from "@/lib/x/constants";
import { X_PRIORITY_FLOOR } from "@/lib/x/priority";
import { allowanceFor } from "@/lib/throttle";
import { withParams } from "@/lib/url";
import {
  X_STATUSES,
  listXOpportunities,
  xOpportunityCard,
  listXLanes,
  projectedWalletCostPerDay,
  xEvaluationEntry,
  xEvaluationReplied,
  xLeadById,
  xThreadOf,
  xStatus,
  type XFeedFilter,
  type XOpportunity,
  type XOpportunityFeed,
  type XStatus,
  type XStatusFilter,
} from "@/lib/x/read";

export type XParams = { project?: string; days?: string; status?: string; at?: string; lead?: string };

/** How long after a check ends its banner may still be shown once, to someone who opens the tab late. */
const DONE_BANNER_MS = 30 * 60_000;

/**
 * The check's own word over the list: a card while X is being searched, a
 * banner once, for a few seconds, when a check has just ended, and nothing after that, when the status
 * line alone says when X was checked.
 */
function ScanState({ status, now }: { status: XStatus; now: Date }) {
  if (status.running) {
    return <ScanRunning text={`${statusLine(status)} Leads appear below as they are found.`} />;
  }
  const run = status.lastRun;
  if (!run?.finishedAt || status.lastFailure || now.getTime() - run.finishedAt.getTime() > DONE_BANNER_MS) {
    return null;
  }
  const found = run.leads + run.replies;
  const next = status.nextScanAt ? ` Next check ${relativeUntil(status.nextScanAt)}.` : "";
  return (
    <Fleeting id={`x-done:${run.id}`}>
      <ScanDone
        title={found === 0 ? "X scan done. No leads this time." : `X scan done. Found ${found} ${found === 1 ? "lead" : "leads"}.`}
        line={`Read ${run.postsNew.toLocaleString()} new ${run.postsNew === 1 ? "post" : "posts"} on X.${next}`}
      />
    </Fleeting>
  );
}

/** What X did last and does next, as one line, where the Leads tab puts its scan status. */
function statusLine(status: XStatus): string {
  if (status.running) {
    return status.running.progress ? `Searching X now: ${status.running.progress}` : "Searching X now.";
  }
  if (status.lastFailure) {
    const retry = status.nextScanAt ? ` Trying again ${relativeUntil(status.nextScanAt)}.` : " Trying again within the hour.";
    return `The last X search stopped: ${errorSentence(status.lastFailure)}${retry}`;
  }
  const last = status.lastScanAt ? `Checked X ${relativeAge(status.lastScanAt)}.` : "X has not been checked yet.";
  const next = status.nextScanAt ? ` Next check ${relativeUntil(status.nextScanAt)}.` : "";
  return `${last}${next}${quietClause(status)}`;
}

/**
 * The status line's word on quiet: "checked weekly" only once the booked check
 * really is a week after the last one, since a check booked before X went
 * quiet still runs at the plan's cadence.
 */
function quietClause(status: XStatus): string {
  if (!status.quiet.quiet || status.lastFailure) return "";
  const weekly =
    status.nextScanAt && status.lastScanAt && status.nextScanAt.getTime() - status.lastScanAt.getTime() >= (QUIET_RECHECK_DAYS - 1) * DAY_MS;
  return weekly ? " Checks are currently weekly." : " After the next check, checks are weekly.";
}

/** A slice key the strip could have made, or nothing. */
function validAt(at: string | undefined): string | undefined {
  const grain = at ? grainOf(at) : null;
  return at && grain && atKey(atBounds(at).start, grain) === at ? at : undefined;
}

/** The filters the list is on, without the open post. */
function listSearch(params: XParams): string {
  return withParams(params, { lead: undefined });
}

/** Open the requested card, or else New's first lead (History's first card). */
async function openOn(
  projectId: string,
  opportunities: XOpportunity[],
  requested?: string,
  history = false,
): Promise<XSelection | null> {
  const found = opportunities.find((one) => xOpportunityCard(one.entry).entryId === requested);
  if (found) return found.entry;
  // A held or filtered-out post the list no longer has: pushed past the cap by
  // a scan, outside a narrower window, or since held, left out or made a lead.
  // It keeps the id it was asked by, which is what the opening row waits for.
  const evaluationId = requested?.match(/^(?:held|filtered)-(.+)$/u)?.[1];
  if (requested && evaluationId) {
    const entry = await xEvaluationEntry(projectId, evaluationId);
    if (entry?.kind === "lead") return { kind: "lead", lead: { ...entry.lead, entryId: requested } };
    if (entry?.kind === "held") return { kind: "held", item: { ...entry.item, entryId: requested } };
    if (entry?.kind === "filtered") return { kind: "filtered", item: { ...entry.item, entryId: requested } };
  }
  if (requested?.startsWith("lead-")) {
    const moved = await xLeadById(projectId, requested.slice("lead-".length));
    if (moved) return { kind: "lead", lead: moved };
  }
  // New opens on its first lead; a post that is not a lead opens only when asked for.
  return opportunities.find((one) => history || one.entry.kind === "lead")?.entry ?? null;
}

/**
 * New, in the order the scan itself counts: people asking, then posts worth a
 * reply, as Leads with their verdicts. Below them, open, the posts that are not
 * leads but whose stored evidence clears the floor (Maybe); then, shut, the
 * rest of what lurk read and left out, best evidence first.
 */
function NewList({ feed, params, selectedId, arriving, empty }: {
  feed: XOpportunityFeed;
  params: XParams;
  selectedId: string | null;
  arriving: boolean;
  empty: string;
}) {
  const leadCount = (feed.leads ?? 0) + (feed.replies ?? 0);
  const leads = feed.items.slice(0, leadCount);
  const others = feed.items.slice(leadCount);
  const maybe = others.filter((item) => item.priority !== null && item.priority >= X_PRIORITY_FLOOR);
  const rest = others.filter((item) => !maybe.includes(item));
  const restTotal = feed.total - leadCount - maybe.length;
  const selected = (items: XOpportunity[]) => items.some((item) => xOpportunityCard(item.entry).entryId === selectedId);
  return (
    <>
      <GroupHeader label="Leads" count={feed.leads ?? 0} note={feed.replies ? `+ ${feed.replies} to reply to` : null} />
      {leads.length > 0 ? (
        <XOpportunityList items={leads} params={params} selectedId={selectedId} />
      ) : arriving && others.length === 0 ? (
        <ArrivingLeads />
      ) : (
        <p className="text-small p-3 text-fg-muted">
          {others.length === 0 ? empty : `Nobody on X asked for what you do or posted anything worth a reply in this window. ${maybe.length > 0 ? "The posts under Maybe below could still be worth a look." : "What lurk read and left out is under Left out below."}`}
        </p>
      )}
      {maybe.length > 0 ? (
        <XGroupDetails selected={selected(maybe)}>
          <GroupSummary label="Maybe" count={maybe.length} warm />
          <p className="text-small border-y px-3 py-2 text-fg-muted">Not leads, but lurk isn&apos;t sure. Worth a quick look.</p>
          <XOpportunityList items={maybe} params={params} selectedId={selectedId} ranked />
        </XGroupDetails>
      ) : null}
      {rest.length > 0 ? (
        <XGroupDetails selected={selected(rest)} initiallyOpen={false}>
          <GroupSummary label="Left out" count={restTotal} />
          <p className="text-small border-y px-3 py-2 text-fg-muted">Posts lurk read and did not count as leads, closest first.</p>
          <XOpportunityList items={rest} params={params} selectedId={selectedId} ranked />
          {restTotal > rest.length ? (
            <p className="text-small border-t p-3 text-fg-muted">The closest {rest.length} of {restTotal} are listed. Narrow the date window to see more.</p>
          ) : null}
        </XGroupDetails>
      ) : null}
    </>
  );
}

/** A group's name and count, stuck to the top of the list column while its rows scroll under it. */
function GroupHeader({ label, count, note }: { label: string; count: number; note?: string | null }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-surface px-3 py-2">
      <span className="text-mono tracking-wide text-fg-muted uppercase">{label}</span>
      <span className="text-mono tabular-nums text-fg-muted">{count}</span>
      {note ? <span className="text-mono tabular-nums text-fg-muted">{note}</span> : null}
    </div>
  );
}

/** The list while the first check fills it, in the Leads tab's own arriving shape. */
function ArrivingLeads() {
  return (
    <div className="flex flex-col">
      <p className="text-small border-b p-3 text-fg-muted">
        lurk is searching X and checking posts against your product. Leads appear here as they are found.
      </p>
      <ListSkeleton rows={4} bare fade={0.2} />
    </div>
  );
}

/** Why the list is empty, in one sentence. */
function emptySentence(
  filter: XFeedFilter,
  status: XStatus,
  laneCount: number,
  activeCount: number,
  name: string,
  canScanNow: boolean,
): string {
  if (laneCount === 0 && status.lastScanAt) {
    return "lurk has no X searches for this product yet. Adding the products you compete with on the Product page gives it more to look for.";
  }
  if (filter.status !== "new") {
    return filter.status === "hidden"
      ? "No X leads you hid in this window."
      : filter.status === "replied"
        ? "No X leads you marked replied in this window."
        : "No X leads you marked a miss in this window.";
  }
  if (!status.lastScanAt && status.lastFailure) {
    return "lurk's first read of the last 30 days on X stopped before it finished, so this list is not complete yet. lurk tries again on its own and shows anyone it finds here. Your Reddit leads are unaffected.";
  }
  // Only a spent budget or an empty wallet explains an empty list; a lookup that failed does not.
  const partial = status.lastRun?.partialReason ?? "";
  if (/budget|cap|balance|spent|wallet/iu.test(partial)) {
    return `${partial.replace(/\.?$/u, ".")} Your Reddit leads are unaffected.`;
  }
  if (status.quiet.quiet && !status.lastFailure) {
    const sooner = canScanNow ? " Scan now still checks at once." : "";
    const read =
      status.quiet.days >= 1
        ? `${status.quiet.posts} posts on X from the last ${status.quiet.days} days`
        : `${status.quiet.posts} recent posts on X`;
    return `X is quiet for ${name}. lurk read ${read}, and nobody asked for what you do, left a competitor, built their own or showed how they do what you sell: the people who buy this may not talk about it on X. lurk checks again each week you open this tab, or while your alerts are on, and shows anyone who turns up.${sooner} Your Reddit leads are unaffected.`;
  }
  if (activeCount === 0) {
    return "Your X searches are paused: they found nothing worth showing, or nothing at all for days. Quiet ones are tried again each week, and changing your product or competitors on the Product page starts them all again.";
  }
  return status.lastRun
    ? `No stored opportunities match this window and your filters. The last check saw ${status.lastRun.postsNew} new posts and judged ${status.lastRun.judged}.`
    : "No stored opportunities match this window and your filters.";
}

/**
 * The X tab for one project, drawn the way the Leads tab is: the project's
 * name and Scan now, one status line, the people strip carrying the filter
 * pills, then the list and the open post side by side. The page above it
 * checks the switch and the owner; this only draws.
 */
export async function XTab({ userId, project, params }: { userId: string; project: { id: string; name: string }; params: XParams }) {
  const filter: XFeedFilter = {
    days: params.days === "1" ? 1 : params.days === "7" ? 7 : 30,
    status: (X_STATUSES as readonly string[]).includes(params.status ?? "") ? (params.status as XStatusFilter) : "new",
    at: validAt(params.at),
  };

  const tier = await limitsForUser(userId);
  const [status, opportunities, lanes, allowance] = await Promise.all([
    xStatus(project.id),
    listXOpportunities(project.id, filter, new Date(), config().X_REPLIES),
    listXLanes(project.id),
    allowanceFor(userId, "x_scan_now"),
  ]);
  const activeLanes = lanes.filter((lane) => lane.state === "active");
  // Until the first check finishes there is nothing to scan again or to price.
  const firstCheck = !status.lastScanAt;
  const selection = await openOn(project.id, opportunities.items, params.lead, filter.status !== "new");
  const selectedCard = selection ? xOpportunityCard(selection) : null;
  const selectedId = selectedCard?.entryId ?? null;
  const selectedOpportunity = opportunities.items.find((item) => xOpportunityCard(item.entry).entryId === selectedId);
  const [thread, replied] = await Promise.all([
    selectedCard ? xThreadOf(selectedCard.tweetId, selectedCard.via?.tweetId ?? null) : null,
    selection && selection.kind !== "lead" ? xEvaluationReplied(project.id, selection.item.evaluationId) : false,
  ]);

  return (
    // The Leads tab's frame: from lg up the page is the window under the
    // header, and the list and the post each scroll inside themselves.
    <div
      key={project.id}
      className="flex flex-col gap-1 lg:h-[calc(100dvh_-_var(--header-height)_-_var(--page-gutter)_*_2)]"
    >
      <StartOnOpen start={openXAction.bind(null, project.id)} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-h3 flex items-baseline gap-2" style={{ fontWeight: 500 }}>
          {project.name}
          <span className="text-mono tracking-wide text-fg-muted uppercase">X leads · beta</span>
        </h2>
        {firstCheck ? null : (
          <form action={scanXNowAction.bind(null, project.id)}>
            <PaidButton label="Scan now" allowance={allowance} note="beside" />
          </form>
        )}
      </div>

      <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1">
        <ScanState status={status} now={new Date()} />
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          {status.running ? null : <p className="text-small text-fg-muted">{statusLine(status)}</p>}
          {tier.name === "free" && tier.limits && !firstCheck && activeLanes.length > 0 && !status.quiet.quiet ? (
            <p className="text-small text-fg-muted">
              Free checks X once a day; a connected wallet checks every search hourly,
              about ${projectedWalletCostPerDay(activeLanes).toFixed(2)} a day from your own balance at this project&apos;s
              volume.{" "}
              <Link href="/app/settings" className="underline">
                Connect a wallet
              </Link>
            </p>
          ) : null}
        </div>

        <PeopleStrip
          faces={opportunities.faces}
          days={filter.days}
          at={filter.at}
          params={params as FeedParams}
          filters={<XFilters days={String(filter.days)} status={filter.status} />}
        />

        <OpeningProvider serverSelectedId={selectedId}>
          <LeadWorkspace
            asked={Boolean(params.lead)}
            backHref={`?${listSearch(params)}`}
            list={
              <>
                {filter.status === "new" ? (
                  <NewList feed={opportunities} params={params} selectedId={selectedId} arriving={firstCheck && (Boolean(status.running) || !status.lastFailure)} empty={emptySentence(filter, status, lanes.length, activeLanes.length, project.name, !allowance.spent)} />
                ) : (
                  <>
                    <GroupHeader label="Leads" count={opportunities.total} />
                    {opportunities.items.length === 0 ? (
                      <p className="text-small p-3 text-fg-muted">
                        {emptySentence(filter, status, lanes.length, activeLanes.length, project.name, !allowance.spent)}
                      </p>
                    ) : (
                      <XOpportunityList items={opportunities.items} params={params} selectedId={selectedId} />
                    )}
                    {opportunities.total > opportunities.items.length ? (
                      <p className="text-small p-3 text-fg-muted">The top {opportunities.items.length} of {opportunities.total} authors are listed. Narrow the date window to see more.</p>
                    ) : null}
                  </>
                )}
                <XSearches lanes={lanes} />
              </>
            }
            pane={selection ? <XLeadDetail selection={selection} projectId={project.id} thread={thread} replied={replied} opportunity={filter.status === "new" ? selectedOpportunity : undefined} /> : null}
          />
        </OpeningProvider>
      </div>
    </div>
  );
}
