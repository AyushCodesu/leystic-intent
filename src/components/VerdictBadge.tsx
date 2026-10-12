import { fitWord, intentWord, judgementSentence, leadRank, rankWord } from "@/lib/scan/words";
import { cn } from "@/lib/utils";

type VerdictBadgeProps = { fit: number | null; intent: number | null; className?: string };

/** The 0-4 fit as four dots, in the chip's own colour, unfilled above the level. */
function FitDots({ fit }: { fit: number }) {
  return (
    <span className="flex items-center gap-[3px]" aria-label={`Fit ${fit} of 4`}>
      {[1, 2, 3, 4].map((step) => (
        <span
          key={step}
          className={cn(
            "size-[5px] rounded-full bg-current",
            step <= fit ? "opacity-100" : "opacity-30",
          )}
        />
      ))}
    </span>
  );
}

/**
 * The model's two answers about this person, as one chip.
 *
 * It used to be the folded score as a percent, and the fold is not a percent of
 * anything: a fifth of it is a freshness clock, so a thread the product fully
 * fits where someone is explicitly asking reads 70 once it is three days old.
 * The number is still the feed's sort order; it is no longer a claim shown to a
 * person. The colour keeps its old meaning and hangs on intent, which is what
 * "hot" was ever about: an explicit near-term decision is hot, an explicit ask
 * is warm, everything else is cool.
 *
 * Then it was two words split by a slash - "Fits fully / Asking" - which reads
 * as one broken phrase, and neither half said what it was about. The two
 * answers are not alike and are no longer drawn alike: where this person is is
 * the sentence, because it is what you act on and when; whether your product is
 * what they need is the four dots beside it, because on a feed it is a
 * comparison between rows rather than a thing you read. One line, one chip.
 */
export function VerdictBadge({ fit, intent, className }: VerdictBadgeProps) {
  const rank = leadRank(fit, intent);
  const tone =
    rank === "strong" ? "text-score-hot" : rank === "good" ? "text-score-warm" : "text-score-cool";
  // The chip says how good the lead is, from both answers; the intent phrase
  // alone read as faint praise on a thread the product fits exactly. With only
  // one answer there is no rank, so that answer's own word stands in.
  const word = rankWord(fit, intent) ?? intentWord(intent) ?? fitWord(fit);
  if (word === null) {
    return null;
  }
  return (
    <span
      // cn treats this custom font-size token as a text colour and otherwise
      // drops it when applying the tone. Keep sizing independent of colour.
      className={`text-mono ${cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 whitespace-nowrap",
        rank === null ? "text-fg-muted" : tone,
        className,
      )}`}
      // The rubric's own sentences, so the chip can always be checked.
      title={judgementSentence(fit, intent) ?? undefined}
    >
      {word}
      {intent !== null && fit !== null ? <FitDots fit={fit} /> : null}
    </span>
  );
}
