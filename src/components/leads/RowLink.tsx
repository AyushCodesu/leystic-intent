"use client";

import Link from "next/link";
import { useOpening, type OpeningSummary } from "@/components/leads/opening";

type RowLinkProps = {
  href: string;
  summary: OpeningSummary;
  /** Whether the server thinks this is the row on screen. */
  selectedOnServer: boolean;
  /** Whether the row sits under the row above it, as part of the same thread. */
  nested?: boolean;
  children: React.ReactNode;
};

/**
 * One row's link. It marks itself selected the moment it is clicked rather
 * than waiting for the server to say so, and hands the pane what it needs to
 * open on the same click.
 *
 * It does not prefetch: a prefetch here is the whole feed read again for every
 * row the pointer crosses, and it is the same read the click itself makes.
 */
export function RowLink({ href, summary, selectedOnServer, nested, children }: RowLinkProps) {
  const { summary: opening, open } = useOpening();
  const selected = opening ? opening.id === summary.id : selectedOnServer;
  return (
    <Link
      href={href}
      scroll={false}
      prefetch={false}
      onClick={() => open(summary)}
      aria-current={selected ? "true" : undefined}
      className={`group/lead-row transition-motion flex items-start gap-2.5 border-b py-2.5 pr-3 last:border-b-0 focus-visible:bg-surface-2 ${
        nested ? "pl-10" : "pl-3"
      } ${
        selected ? "bg-surface-2" : "hover:bg-surface-2"
      }`}
    >
      {children}
    </Link>
  );
}
