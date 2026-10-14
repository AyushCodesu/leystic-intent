"use client";

import { useState } from "react";

/**
 * A collapsible group in the X list column that the open post can open but
 * never shut. The server knows only which post is open, so a group that took
 * its open state from that closed each time Back cleared the post: on a phone,
 * every post read from a long group sent the reader back to its top. Here a
 * group starts open unless told otherwise, the reader's own toggle stands, and
 * opening one of its posts opens it.
 */
export function XGroupDetails({
  selected,
  initiallyOpen = true,
  children,
}: {
  selected: boolean;
  initiallyOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen || selected);
  const [wasSelected, setWasSelected] = useState(selected);
  if (selected !== wasSelected) {
    setWasSelected(selected);
    if (selected) {
      setOpen(true);
    }
  }
  return (
    <details className="group border-t" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      {children}
    </details>
  );
}
