import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/brand";
import { LeysticMark } from "./LeysticMark";

type WordmarkProps = { homeHref?: string };

/**
 * Leystic wordmark with journey path mark.
 */
export function Wordmark({ homeHref }: WordmarkProps) {
  return (
    <span className="wordmark flex items-center gap-2 text-fg" style={{ fontWeight: 600 }}>
      {homeHref ? (
        <Link href={homeHref} aria-label={`${PRODUCT_NAME} home`} className="flex items-center gap-2 hover:opacity-90">
          <LeysticMark size={20} />
          <span className="tracking-tight">{PRODUCT_NAME}</span>
        </Link>
      ) : (
        <span className="flex items-center gap-2">
          <LeysticMark size={20} />
          <span className="tracking-tight">{PRODUCT_NAME}</span>
        </span>
      )}
    </span>
  );
}
