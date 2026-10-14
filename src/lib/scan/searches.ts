import { z } from "zod";
import { generateStructured } from "@/lib/llm";
import { productState, type ProductFacts } from "@/lib/product";
import { SWEEP_SEARCHES_SYSTEM } from "@/lib/prompts";
import { askedText } from "@/lib/discovery/rank";

/**
 * The first six ordered by how many leads a search of each kind found per 100
 * posts in the 2026-09-19 experiment; the rival questions, measured in another
 * (2026-10-13), come after so a widened project still gets tool asks and rivals.
 */
export const KINDS = [
  "tool_ask",
  "alternative_to",
  "symptom",
  "acting_for",
  "workaround",
  "moment",
  "rival_vs",
  "rival_worth_it",
  "rival_anyone_use",
] as const;

export type SweepSearch = { kind: (typeof KINDS)[number]; text: string };

const schema = z.object({
  searches: z.array(z.object({ kind: z.enum(KINDS), text: z.string() })),
});

/** The most searches one sweep adds, whatever the model returns. */
const MOST = 22;

/**
 * The searches a first sweep adds to the page's own phrasings: one model call,
 * about 5 seconds and $0.0002 at minimal effort. The first Reddit search waits
 * on it, so it was measured 2026-09-25 against low (.context/fast/min): 12.1 s
 * to 5.3 s at the median, and on one Reddit page each of the 236 searches only
 * one effort wrote, for 15 products, 542 buyer leads against 541. They are
 * asked of Reddit and never stored as phrasings, which also feed Google
 * discovery and the Reddit SEO tab, where a rival's name has no place. A sweep without them is still a sweep, so a call
 * that fails or an instance with no model key adds nothing and says nothing.
 */
export async function sweepSearches(projectId: string, product: ProductFacts): Promise<string[]> {
  return (await sweepSearchItems(projectId, product)).map((item) => item.text);
}

/** The same searches with the kind each was written as, deduplicated, in the model's order. */
export async function sweepSearchItems(
  projectId: string,
  product: ProductFacts,
): Promise<SweepSearch[]> {
  try {
    const made = await generateStructured({
      purpose: "sweep_searches",
      projectId,
      schema,
      effort: "minimal",
      system: SWEEP_SEARCHES_SYSTEM,
      prompt: JSON.stringify({ product: productState(product) }),
    });
    const seen = new Set<string>();
    const items: SweepSearch[] = [];
    for (const item of made.searches) {
      const text = askedText(item.text);
      if (text.length > 0 && !seen.has(text)) {
        seen.add(text);
        items.push({ kind: item.kind, text });
      }
    }
    return items.slice(0, MOST);
  } catch {
    return [];
  }
}
