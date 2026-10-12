import { AuthorAvatar } from "@/components/AuthorAvatar";
import { RowLink } from "@/components/leads/RowLink";
import { shortAge } from "@/lib/format";

type XLeadRowProps = {
  id: string;
  href: string;
  selected: boolean;
  headline: string;
  author: string;
  avatarUrl: string | null;
  createdAt: Date;
  /** The handle a reply answers, named where a Reddit row names its thread. */
  replyingTo: string | null;
  /** A short mono fact after the age, such as a reply-worthy post's views. */
  meta?: string | null;
  trailing: React.ReactNode;
  /** Lower visual emphasis, without hiding the post or weakening its interaction states. */
  subdued?: boolean;
};

/**
 * One X post in the list column, drawn as a Reddit lead row is: the face with
 * its platform's mark, the ask, then where and when in mono, and one rating.
 * Where a Reddit row names its community, an X row names its author.
 */
export function XLeadRow({ id, href, selected, headline, author, avatarUrl, createdAt, replyingTo, meta, trailing, subdued = false }: XLeadRowProps) {
  return (
    <RowLink
      href={href}
      selectedOnServer={selected}
      summary={{
        id,
        title: headline,
        author,
        avatarUrl,
        subreddit: "",
        subredditIconUrl: null,
        createdAt,
        trailing,
        platform: "x",
      }}
    >
      <span className={subdued ? "shrink-0 grayscale opacity-60 transition-[opacity,filter] group-hover/lead-row:grayscale-0 group-hover/lead-row:opacity-100 group-focus-visible/lead-row:grayscale-0 group-focus-visible/lead-row:opacity-100 group-aria-[current=true]/lead-row:grayscale-0 group-aria-[current=true]/lead-row:opacity-100" : "shrink-0"}>
        <AuthorAvatar name={author} src={avatarUrl} size={24} platform="x" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={`text-small max-sm:line-clamp-2 sm:truncate ${subdued ? "font-normal text-fg-muted transition-[color] group-hover/lead-row:text-fg group-focus-visible/lead-row:text-fg group-aria-[current=true]/lead-row:text-fg" : "font-medium text-fg"}`}>
          {headline}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-mono min-w-0 truncate text-fg-muted">@{author}</span>
          <span className="text-mono shrink-0 text-fg-muted">{shortAge(createdAt)}</span>
          {meta ? <span className="text-mono min-w-0 truncate text-fg-muted">{meta}</span> : null}
          {replyingTo ? (
            <span className="text-small min-w-0 flex-1 truncate text-fg-muted">replying to {replyingTo}</span>
          ) : null}
        </span>
      </span>
      <span className="shrink-0 pt-0.5">{trailing}</span>
    </RowLink>
  );
}

/** The handle a reply answers, from its first `@handle: text` context line. */
export function repliedHandle(replyingTo: string[]): string | null {
  const last = replyingTo.at(-1);
  return last ? (last.split(":")[0] ?? null) : null;
}
