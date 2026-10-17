import Link from "next/link";
import { ArrowUpDown, CalendarDays, Filter, Hash, Target, X } from "lucide-react";
import { FilterPills, type FilterSpec } from "@/components/FilterPills";
import { atLabel, FEED_WINDOWS, type FeedFacets, type FeedParams } from "@/lib/feed";
import { withParams } from "@/lib/url";

type FeedFiltersProps = {
  facets: FeedFacets;
  /** The slice of the clock a strip column picked, when one has been. */
  at?: string;
  params: FeedParams;
};

/** The same page without the slice, keeping every other filter. */
function clearedHref(params: FeedParams): string {
  return `?${withParams(params, { at: undefined, lead: undefined })}`;
}

const WINDOW_LABELS: Record<string, string> = {
  1: "Today",
  7: "7 days",
  30: "30 days",
  all: "All time",
};

const STATUS_LABELS: Record<string, string> = {
  new: "New",
  replied: "Replied",
  hidden: "Hidden",
  not_fit: "Not a fit",
  resolved: "Resolved",
};

function label(stage: string): string {
  return stage.replace(/_/g, " ");
}

const ICON = "size-3.5 shrink-0 text-fg-muted";

/** The row of pills over the feed: when, where, how far along, and what state. */
export function FeedFilters({ facets, at, params }: FeedFiltersProps) {
  const filters: FilterSpec[] = [
    {
      name: "days",
      ariaLabel: "days",
      icon: <CalendarDays className={ICON} aria-hidden="true" />,
      // The window the feed opened on, which is the year when nobody chose one
      // and the last 30 days were empty.
      fallback: params.days ?? "30",
      options: FEED_WINDOWS.map((days) => ({
        value: String(days),
        label: WINDOW_LABELS[days],
      })),
    },
    {
      name: "subreddit",
      ariaLabel: "subreddit",
      icon: <Hash className={ICON} aria-hidden="true" />,
      fallback: "",
      searchable: true,
      searchPlaceholder: "r/webscraping",
      options: [
        { value: "", label: "All subreddits" },
        ...facets.subreddits.map((name) => ({ value: name.toLowerCase(), label: `r/${name}` })),
      ],
    },
    {
      name: "stage",
      ariaLabel: "stage",
      icon: <Target className={ICON} aria-hidden="true" />,
      fallback: "",
      options: [
        { value: "", label: "Any stage" },
        ...facets.stages.map((stage) => ({ value: stage, label: label(stage) })),
      ],
    },
    {
      name: "status",
      ariaLabel: "status",
      icon: <Filter className={ICON} aria-hidden="true" />,
      fallback: "new",
      options: Object.entries(STATUS_LABELS).map(([value, text]) => ({ value, label: text })),
    },
    {
      name: "order",
      ariaLabel: "ordering",
      icon: <ArrowUpDown className={ICON} aria-hidden="true" />,
      fallback: "score",
      options: [
        { value: "score", label: "Score order" },
        { value: "learned", label: "Learned priority" },
      ],
    },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/*
        A slice picked in the strip is a filter like any other, so it says so
        where the others do. It is not one of the pills because it has no list
        to choose from: the strip is its control, and this is the receipt.
      */}
      {at ? (
        <Link
          href={clearedHref(params)}
          className="text-small inline-flex items-center gap-1.5 rounded-control border border-fg bg-surface-2 py-1 pr-2 pl-2.5 text-fg"
        >
          <CalendarDays className="size-3.5 shrink-0" aria-hidden="true" />
          {atLabel(at)}
          <X className="size-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
          <span className="sr-only">Clear this filter</span>
        </Link>
      ) : null}
      <FilterPills filters={filters} />
    </div>
  );
}
