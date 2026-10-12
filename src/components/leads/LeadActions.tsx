"use client";

import { useState } from "react";
import { BellOff, Check, ExternalLink, EyeOff, RotateCcw, ThumbsDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { errorFrom } from "@/lib/actionError";
import type { ActionResult } from "@/lib/actionResult";

/** Why a lead someone was asking in was a miss, unless the pane offers its own list. */
const NOT_FIT_REASONS = [
  "wrong audience",
  "seller side",
  "no active need",
  "wrong category",
  "other",
];

/** What the buttons do, each server action already bound to its lead by the pane that draws them. */
export type LeadActionHandlers = {
  replied: () => Promise<void>;
  reopen: () => Promise<void>;
  /** Absent for a post that is not a lead (an X post New ranked from evidence): there is no lead to hold the mark. */
  hide?: () => Promise<void>;
  /** Comes back with a sentence when it refused, which shows under the picker. Absent as hide is. */
  notFit?: (formData: FormData) => Promise<ActionResult>;
  /** Mutes where the lead was found, with the button's words ("Mute r/saas"). */
  mute?: { label: string; action: () => Promise<void> };
};

type LeadActionsProps = {
  /** The filled button's words: "Open on Reddit", "Open on X". */
  openLabel: string;
  url: string;
  /** Null for a post that gets only the link. */
  actions: LeadActionHandlers | null;
  /** The thread is already marked replied, so the button takes that back instead. */
  replied?: boolean;
  reasons?: string[];
};

/**
 * The foot of the detail pane. Reading the post where it was written is the
 * one thing this page leads to, so it is the only filled button; the rest take
 * the lead out of the feed or record why it was wrong. Replied covers the
 * whole thread (a Reddit post, an X conversation), and mute the whole
 * community, in the feed and every alert channel alike.
 */
export function LeadActions({ openLabel, url, actions, replied = false, reasons = NOT_FIT_REASONS }: LeadActionsProps) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconClass = "size-3.5 text-fg-muted";

  return (
    <div className="flex shrink-0 flex-col gap-3 border-t p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="lg"
          nativeButton={false}
          render={
            <a href={url} target="_blank" rel="noreferrer noopener">
              <ExternalLink className="size-3.5" aria-hidden="true" />
              {openLabel}
            </a>
          }
        />
        {actions ? (
          <>
            {replied ? (
              <form action={actions.reopen}>
                <Button type="submit" variant="ghost" size="sm">
                  <RotateCcw className={iconClass} aria-hidden="true" />
                  Not replied
                </Button>
              </form>
            ) : (
              <form action={actions.replied}>
                <Button type="submit" variant="ghost" size="sm">
                  <Check className={iconClass} aria-hidden="true" />
                  Replied
                </Button>
              </form>
            )}
            {actions.hide ? (
              <form action={actions.hide}>
                <Button type="submit" variant="ghost" size="sm">
                  <EyeOff className={iconClass} aria-hidden="true" />
                  Hide
                </Button>
              </form>
            ) : null}
            {!actions.notFit ? null : picking ? (
              <form
                action={async (formData) => setError(await errorFrom(() => actions.notFit!(formData)))}
                className="flex items-center gap-1.5"
              >
                <Select
                  name="reason"
                  required
                  ariaLabel="Why this lead is not a fit"
                  placeholder="Pick a reason"
                  className="h-7"
                  options={reasons.map((reason) => ({ value: reason, label: reason }))}
                />
                <Button type="submit" variant="outline" size="sm">
                  Save
                </Button>
              </form>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
                <ThumbsDown className={iconClass} aria-hidden="true" />
                Not a fit
              </Button>
            )}
            {actions.mute ? (
              <form action={actions.mute.action}>
                <Button type="submit" variant="ghost" size="sm">
                  <BellOff className={iconClass} aria-hidden="true" />
                  {actions.mute.label}
                </Button>
              </form>
            ) : null}
          </>
        ) : null}
      </div>
      {error ? <p className="text-small text-reddit">{error}</p> : null}
    </div>
  );
}
