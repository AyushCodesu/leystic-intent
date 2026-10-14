import { ChevronRight, Search } from "lucide-react";
import { XLeadRow, repliedHandle } from "@/components/x/XLeadRow";
import { entryHref } from "@/components/leads/workspace";
import { XGroupDetails } from "@/components/x/XGroupDetails";
import { compactCount } from "@/lib/format";
import { filteredStrength, filteredSummary, filteredWord } from "@/components/x/filtered";
import type { XFiltered, XFilteredCard, XHeldCard, XLaneView } from "@/lib/x/read";

/** One collapsible group's header: its name and count, the Leads group's own look. */
export function GroupSummary({ label, count, warm = false }: { label: string; count: number; warm?: boolean }) {
  return (
    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
      <ChevronRight className="transition-motion size-3.5 text-fg-muted group-open:rotate-90" aria-hidden="true" />
      <span className={`text-mono tracking-wide uppercase ${warm ? "text-score-warm" : "text-fg-muted"}`}>{label}</span>
      <span className="text-mono tabular-nums text-fg-muted">{count}</span>
    </summary>
  );
}

/**
 * Everything lurk could not call either way, as one group under Leads and
 * open from the start: posts the scan held, then the left-out posts worth a
 * look (close calls, unfinished checks, turned away but still scoring well).
 * To the reader these are the same thing: check them yourself.
 */
export function XMaybeSection({
  held,
  filtered,
  params,
  selectedId,
}: {
  held: XHeldCard[];
  filtered: XFiltered;
  params: Record<string, string | undefined>;
  selectedId: string | null;
}) {
  const worth = filtered.items.filter((item) => item.band === "worth");
  if (held.length === 0 && worth.length === 0) {
    return null;
  }
  const selected = held.some((item) => item.entryId === selectedId) || worth.some((item) => item.entryId === selectedId);
  return (
    <XGroupDetails selected={selected}>
      <GroupSummary label="Maybe" count={held.length + filtered.worth} warm />
      <p className="text-small border-t px-3 py-2 text-fg-muted">Could be leads, but lurk isn&apos;t sure. Worth a quick look.</p>
      {held.map((item) => (
        <XLeadRow
          key={item.entryId}
          id={item.entryId}
          href={entryHref(params, item.entryId)}
          selected={item.entryId === selectedId}
          headline={item.headline}
          author={item.authorUsername}
          avatarUrl={item.authorImage}
          createdAt={item.postedAt}
          replyingTo={repliedHandle(item.replyingTo)}
          trailing={<span className="text-mono text-score-warm">unsure</span>}
        />
      ))}
      {worth.map((item) => filteredRow(item, params, selectedId))}
    </XGroupDetails>
  );
}

/**
 * The rest of what the scan read and left out, as one flat list,
 * open as the Leads tab keeps its pile in view: judged posts best first, then posts set aside by rule. Each row's
 * word says why; its bar is the judge's score where there is one.
 */
export function XLeftOutSection({
  filtered,
  params,
  selectedId,
}: {
  filtered: XFiltered;
  params: Record<string, string | undefined>;
  selectedId: string | null;
}) {
  const items = filtered.items.filter((item) => item.band !== "worth");
  if (items.length === 0) {
    return null;
  }
  const total = filtered.judged + filtered.screened + filtered.unfinished - filtered.worth;
  return (
    <XGroupDetails selected={items.some((item) => item.entryId === selectedId)}>
      <GroupSummary label="Left out" count={total} />
      <p className="text-small border-t px-3 py-2 text-fg-muted">{filteredSummary(filtered)}</p>
      {items.map((item) => filteredRow(item, params, selectedId))}
    </XGroupDetails>
  );
}

function filteredRow(item: XFilteredCard, params: Record<string, string | undefined>, selectedId: string | null) {
  return (
    <XLeadRow
      key={item.entryId}
      id={item.entryId}
      href={entryHref(params, item.entryId)}
      selected={item.entryId === selectedId}
      headline={item.headline}
      author={item.authorUsername}
      avatarUrl={item.authorImage}
      createdAt={item.postedAt}
      replyingTo={repliedHandle(item.replyingTo)}
      meta={item.band === "rule" && (item.viewCount ?? 0) >= 1000 ? `${compactCount(item.viewCount ?? 0)} views` : null}
      trailing={<FilteredTrailing item={item} />}
    />
  );
}

/** A row's rating: the judge's score as a small bar, then why it was left out. */
function FilteredTrailing({ item }: { item: XFilteredCard }) {
  const warm = item.band === "worth";
  const scored = filteredStrength(item.score);
  // Everything in the band reached its line (two bars) one way or another: a close call can score low on freshness alone.
  const strength = scored === null ? null : warm ? Math.max(2, scored) : scored;
  const word = item.closeCall ? "close call" : filteredWord(item);
  return (
    <span className="flex items-center gap-2">
      {strength === null ? null : (
        <span className="flex items-center gap-0.5" aria-label={`score ${item.score} of 100`} title={`Scored ${item.score} of 100`}>
          {[1, 2, 3, 4].map((step) => (
            <span
              key={step}
              className={`h-1.5 w-2 rounded-full ${step <= strength ? (warm ? "bg-score-warm" : "bg-score-cool") : "bg-border"}`}
            />
          ))}
        </span>
      )}
      <span className={`text-mono ${warm ? "text-score-warm" : "text-fg-muted"}`}>{word}</span>
    </span>
  );
}

const STATE_WORD: Record<string, string> = {
  paused: "paused: nothing worth showing in what it found, or nothing found for days",
  refused: "stopped: not a search X accepts",
};

/**
 * What lurk asks X for this project, as the last group in the list column.
 * X matches words exactly, so each search ties a competitor, the category or
 * the job to the words people leave, rebuild or show it in; the exact query is
 * shown.
 */
export function XSearches({ lanes }: { lanes: XLaneView[] }) {
  if (lanes.length === 0) {
    return null;
  }
  return (
    <details className="group border-t">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <ChevronRight className="transition-motion size-3.5 text-fg-muted group-open:rotate-90" aria-hidden="true" />
        <span className="text-mono tracking-wide text-fg-muted uppercase">Searches on X</span>
        <span className="text-mono tabular-nums text-fg-muted">{lanes.length}</span>
      </summary>
      <p className="text-small border-t px-3 py-2 text-fg-muted">
        Each search asks X, word for word, for one of three things: people leaving or weighing the products you compete
        with, people building their own, and popular posts showing how people do what you sell. They are written from
        your Product page, and change when it does.
      </p>
      {lanes.map((lane) => (
        <div key={lane.id} className="flex flex-col gap-1.5 border-t px-3 py-2.5">
          <span className="flex items-center gap-2">
            <Search className="size-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
            <span className="text-small text-fg" style={{ fontWeight: 500 }}>
              {lane.label ?? lane.seeds.join(", ")}
            </span>
            {STATE_WORD[lane.state] ? <span className="text-mono text-fg-muted">{STATE_WORD[lane.state]}</span> : null}
          </span>
          <span className="text-mono tabular-nums text-fg-muted">
            {lane.posts} seen · {lane.screenedOut} screened out · {lane.judged} judged · {lane.leads} asking · {lane.replies}{" "}
            worth a reply · {lane.reviews} held
          </span>
          <code className="text-mono overflow-x-auto break-all whitespace-pre-wrap rounded-control bg-surface-2 px-2 py-1 text-fg-muted">
            {lane.body}
          </code>
        </div>
      ))}
    </details>
  );
}
