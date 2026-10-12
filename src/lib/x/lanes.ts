import { createHash } from "node:crypto";
import { plainTypography } from "@/lib/scan/evidence";
import { assertLane, isRefusedLoneWord } from "./grammar";
import { MAX_LANE_BODY_CHARS, MAX_RIVALS_PER_LANE, X_LANES_VERSION, X_LANG } from "./constants";
import { isAmbiguous, normalizeEntity, slug } from "./words";

/**
 * Deterministic X lanes: code builds every query, from terms.
 *
 * X search is literal: every bare word is required, nothing is stemmed, and
 * the newest 20 matches come back, not the best. A lane is therefore one to
 * three AND groups of alternatives, each group parenthesized when it has more
 * than one, every word form spelled out. The shapes transfer between products
 * and the words never do, so a model fills the words (seeds.ts) and this file
 * fills the shapes.
 *
 * The first three families came from what a live probe of seven unlike products found on
 * 2026-09-27 (.context/x-general: 48 searches, 521 posts, labelled and
 * skeptic-checked):
 * - rival: someone leaving, weighing or stuck on a named rival. The buyers:
 *   "Is there any alternative to calendly???".
 * - diy: someone building their own version of what the product sells, or
 *   replacing it. A founder replies there ("we vibe coded our own Calendly++"):
 *   2 of 12 posts, the best precision of any family.
 * - stack: someone showing the workflow they do the product's job with, in
 *   the tools people build in, with reach. 24 of the 26 posts one founder chose
 *   to plug his product on were this kind of post or a price gripe, not asks.
 * Price complaints on their own (0 of 51), open calls (0 of 29), hiring and
 * opening posts (0 of 36) and pain phrasing without a named system found
 * nothing, and are not lanes.
 * - request: someone asking for a thing of the product's category by name
 *   ("looking for a screen recorder", "best booking page?"). In a blind
 *   grading of 415 archived posts (October 2026) these lanes found 12 of the
 *   14 good leads; diy and stack found none. Buyers, so not a venue family,
 *   and replies are kept: an ask is often a reply in someone else's thread.
 *   A second request shape names the coined rivals instead of the category
 *   ("Best self hosted open source calendly, cal?"); see compileRivalRequestLane.
 */

export type LaneFamily = "rival" | "request" | "diy" | "stack";

/** The families whose posts may be worth a reply though nobody in them is shopping: a venue, not a buyer. */
export const VENUE_FAMILIES: ReadonlySet<string> = new Set<LaneFamily>(["diy", "stack"]);

export type CompiledLane = {
  family: LaneFamily;
  /** The rivals a lane covers, normalized; empty for a stack lane. */
  seeds: string[];
  /** AND groups of OR alternatives, lowercase. */
  terms: string[][];
  /** What the lane looks for, for the tab. */
  label: string;
  /** Exact case, no since_time; the call adds `since_time:<unix>` at the end. */
  body: string;
};

/**
 * The words a coined rival is bound to: leaving it, weighing it, or it being
 * down. On 2026-09-27's live pages every genuine post said "alternative" in
 * the same sentence as the brand, and posts that matched only on a cost word
 * (13 on AnyAPI's rivals, 0 of 51 across seven products) or a breakage word
 * (22) were none of them genuine, so neither is here. "cheaper" stays: "like
 * Calendly but cheaper" is a switch.
 */
export const RIVAL_WORDS = [
  "alternative",
  "alternatives",
  "switching from",
  "switched from",
  "switch from",
  "moving away from",
  "moved off",
  "ditched",
  "replacement",
  "cheaper",
  "vs",
  "thoughts on",
  "anyone use",
  "is down",
];

/** The words someone building or replacing their own version of a product writes, every form X needs spelled out. */
export const DIY_WORDS = [
  "vibe coded",
  "built my own",
  "built our own",
  "build my own",
  "build our own",
  "building my own",
  "building our own",
  "rolled our own",
  "instead of paying",
  "replaced",
  "replacing",
  "vibecoded",
];

/** Requests for something to use, not bare categories or generic how-to posts. */
export const REQUEST_WORDS = ["looking for", "recommend", "recommendations", "suggest", "suggestions", "need a", "need an", "alternative", "alternatives", "best", "which", "anyone know", "what do you use"];

/**
 * The tools and phrases a workflow post is written in. The founder's best
 * targets named one ("Claude Code can now scrape Instagram & TikTok", "apify
 * + claude + gmail, my setup"); a rival's name in this place instead returned
 * hackathon clusters and listicles.
 */
export const HARNESS_WORDS = [
  "claude code",
  "codex",
  "n8n",
  "zapier",
  "make.com",
  "vibe coded",
  "custom built",
  "my stack",
  "our stack",
  "tech stack",
  "my workflow",
  "our workflow",
];

/**
 * Likes a workflow post needs before it is read: the founder's replies on
 * posts under 1k views got about 50 views, and a like floor is how X search
 * returns only posts people are reading.
 */
export const STACK_MIN_FAVES = 20;

/** The words a model fills per product; see seeds.ts for what each one is. */
export type SeedSlots = {
  /** Nouns for this category of product, as someone building or replacing one writes them ("booking page"). */
  artifacts: string[];
  /** Words a post about doing this product's job contains ("round robin", "ai visibility", "scraping"). */
  topics: string[];
  /** Competitor names that are also everyday words ("doodle", "chaser"): never in a shared group, never bare. */
  ordinaryWordRivals?: string[];
  /** Competitor rows that name no product ("this", "contact form"): never searched. */
  notProducts?: string[];
};

const MAX_SLOT_TERMS = 8;
/** Rivals and artifacts a build-vs-buy lane names at most: the DIY words take most of the query. */
const MAX_DIY_NAMES = 8;
/** Rivals a build-vs-buy lane names at most, so the category's own nouns always have room beside them. */
const MAX_DIY_RIVALS = 4;
/** A workflow lane needs at least this many of the tools people build in, once the project's own and its rivals' are taken out. */
const MIN_HARNESS = 6;

/**
 * Words that, as the whole of a group a lane leans on, name no category:
 * "artifacts filled with app, tool, api, extension, plugin, and service
 * returned literary agents, DeFi bridges, and police body cameras… Seven lanes,
 * about 140 posts, not one in the category" (Eve, seed-lanes.yaml).
 */
const GENERIC = new Set([
  "api", "apis", "app", "apps", "tool", "tools", "software", "service", "services", "platform", "platforms",
  "plugin", "plugins", "extension", "extensions", "solution", "solutions", "product", "products", "system",
  "systems", "website", "websites", "data", "ai", "saas", "startup", "business", "online", "free",
]);
/** One-word terms too common to be an object or an operation anyone searches by. */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "for", "in", "on", "at", "my", "our", "your", "it", "get", "got", "use", "do", "make", "made", "have", "things", "stuff",
]);

/** One alternative as X reads it: a word bare; a phrase, or a word with a dot or a symbol in it, quoted. */
function alternative(term: string): string {
  return /^[\p{L}\p{N}][\p{L}\p{N}'-]*$/u.test(term) ? term : `"${term}"`;
}

/** What a lane asks of X beyond its words: top-level posts only, and a like floor. */
export type LaneFilters = { topLevelOnly?: boolean; minFaves?: number };

export function bodyOf(terms: string[][], filters: LaneFilters = {}): string {
  const groups = terms.map((group) =>
    group.length === 1 ? alternative(group[0]) : `(${group.map(alternative).join(" OR ")})`,
  );
  const tail = [
    `lang:${X_LANG}`,
    "-filter:retweets",
    ...(filters.topLevelOnly ? ["-filter:replies"] : []),
    ...(filters.minFaves ? [`min_faves:${filters.minFaves}`] : []),
  ];
  return `${groups.join(" ")} ${tail.join(" ")}`;
}

/**
 * A term the way a lane can hold it, or null: lowercase, straight quotes, one
 * to four words, nothing X would read as an operator or a group, and letters
 * or digits at each word's start. A lone "or", "and" or "not" is refused; inside
 * a phrase ("back and forth", "not working") it is only a word.
 */
export function cleanTerm(value: string, minWords = 1): string | null {
  const cleaned = plainTypography(value)
    .replace(/["()*:@#]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length < minWords || words.length > 4) return null;
  if (!words.every((part) => /^[\p{L}\p{N}][\p{L}\p{N}.+'&-]*$/u.test(part))) return null;
  if (words.length === 1 && (["or", "and", "not"].includes(words[0]) || word(words[0]).length < 2 || /^\d+$/u.test(words[0]))) {
    return null;
  }
  return words.join(" ");
}

function word(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Whether a term names the product or a rival, word by word: "firecrawl api"
 * and "apify pricing" are rival lanes wearing a pain label, and a multi-word
 * rival name counts wherever it starts a word of the term.
 */
function namesExcluded(term: string, exclude: Set<string>, phrases: string[]): boolean {
  if (exclude.has(slug(term)) || term.split(" ").some((part) => exclude.has(slug(part)))) return true;
  return phrases.some((phrase) => (` ${term} `).includes(` ${phrase} `));
}

/** A slot's terms, cleaned, deduplicated and capped; a lone generic or stop word is dropped. */
function slotTerms(
  values: string[],
  opts: { minWords?: number; dropGeneric?: boolean; exclude: Set<string>; excludePhrases: string[] },
): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    const term = cleanTerm(value, opts.minWords ?? 1);
    if (!term || seen.has(term)) continue;
    if (opts.dropGeneric && GENERIC.has(term)) continue;
    if (!term.includes(" ") && (STOPWORDS.has(term) || word(term).length <= 2 || isRefusedLoneWord(term))) continue;
    if (namesExcluded(term, opts.exclude, opts.excludePhrases)) continue;
    seen.add(term);
    kept.push(term);
    if (kept.length >= MAX_SLOT_TERMS) break;
  }
  return kept;
}

/**
 * Drops alternatives from the end of one group, the one the product filled
 * (names or topics), until the body fits the lane limit, or null if it never
 * does. The fixed word lists are the shape the evidence chose and are never
 * cut: trimming them first would keep a model's redundant plurals and lose
 * "replaced" or "my workflow".
 */
function fitTerms(terms: string[][], filters: LaneFilters = {}, trim = 0): string[][] | null {
  const groups = terms.map((group) => [...group]);
  while (bodyOf(groups, filters).length > MAX_LANE_BODY_CHARS) {
    const group = groups[trim];
    if (!group || group.length <= 1) return null;
    group.pop();
  }
  return groups;
}

function listed(values: string[], most = 3): string {
  const shown = values.slice(0, most);
  return values.length > most ? `${shown.join(", ")}…` : shown.join(", ");
}

/**
 * A lane from terms, or null when it cannot be one the guard accepts. `trim`
 * is the group that may shrink to fit; the label is written from the terms
 * that survived, so it never names a word the search no longer holds.
 */
function laneOf(
  family: LaneFamily,
  terms: string[][],
  label: (fitted: string[][]) => { label: string; seeds: string[] },
  filters: LaneFilters = {},
  trim = 0,
): CompiledLane | null {
  if (terms.length === 0 || terms.some((group) => group.length === 0)) return null;
  const fitted = fitTerms(terms, filters, trim);
  if (!fitted) return null;
  const body = bodyOf(fitted, filters);
  try {
    assertLane(body);
  } catch {
    return null;
  }
  return { family, ...label(fitted), terms: fitted, body };
}

/** Every phrase for one common-word rival: only noun-bound ones, since "switching from notion" reads as English. */
export function rivalPhrases(entity: string): string[] {
  return [`alternative to ${entity}`, `${entity} alternative`, `${entity} alternatives`, `alternatives to ${entity}`];
}

/** The rivals a project's competitors make, in standing order, without its own name or duplicates. */
export function rivalSeeds(competitors: string[], ownNames: string[]): string[] {
  const own = new Set(ownNames.map(slug).filter(Boolean));
  const seen = new Set<string>();
  const seeds: string[] = [];
  for (const name of competitors) {
    const entity = normalizeEntity(name);
    if (!entity || own.has(slug(entity)) || seen.has(entity)) {
      continue;
    }
    seen.add(entity);
    seeds.push(entity);
  }
  return seeds;
}

function coinedRivalLane(rivals: string[]): CompiledLane | null {
  return laneOf("rival", [rivals, RIVAL_WORDS], ([kept]) => ({ label: `Leaving or weighing ${listed(kept)}`, seeds: kept }));
}

function commonRivalLane(rival: string): CompiledLane | null {
  return laneOf("rival", [rivalPhrases(rival)], () => ({ label: `Asking for an alternative to ${rival}`, seeds: [rival] }));
}

/**
 * The names the model called everyday words that really are: letters, spaces,
 * hyphens and apostrophes only. A name with a dot, a digit or a plus
 * ("context.dev", "otterly.ai", "youcanbook.me") is coined whatever the model
 * said, since nobody writes it in an ordinary sentence.
 */
export function everydayNames(ordinary: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const name of ordinary) {
    const entity = normalizeEntity(name);
    if (entity && /^[\p{L}][\p{L}' -]*$/u.test(entity)) names.add(slug(entity));
  }
  return names;
}

function isCommonRival(entity: string, everyday: Set<string>): boolean {
  return isAmbiguous(entity) || everyday.has(slug(entity));
}

/** The rivals that may share an OR group, in standing order: coined names that can make a rival lane alone. */
function coinedRivals(seeds: string[], ordinary: Iterable<string> = []): string[] {
  const everyday = everydayNames(ordinary);
  return seeds.filter((entity) => !isCommonRival(entity, everyday) && coinedRivalLane([entity]) !== null);
}

/**
 * Rival lanes. Coined names share one OR group, up to MAX_RIVALS_PER_LANE and
 * the lane limit, bound to RIVAL_WORDS. A name that is also an everyday word
 * (Loom, Notion, Doodle, Chaser) never shares a group and never runs bare: it
 * gets its own lane of noun-bound phrases. On 2026-09-27 "doodle" was 5 of 6
 * of Cal.com's rival posts and "contact form" 17 of 20 of Tally's. A name that
 * cannot make a lane on its own is skipped, so it never sinks the others.
 */
export function compileRivalLanes(seeds: string[], ordinary: Iterable<string> = []): CompiledLane[] {
  const lanes: CompiledLane[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const lane = coinedRivalLane(current);
    if (lane) lanes.push(lane);
    current = [];
  };
  for (const entity of coinedRivals(seeds, ordinary)) {
    const next = [...current, entity];
    const fits = next.length <= MAX_RIVALS_PER_LANE && bodyOf([next, RIVAL_WORDS]).length <= MAX_LANE_BODY_CHARS;
    if (!fits) flush();
    current.push(entity);
  }
  flush();
  const everyday = everydayNames(ordinary);
  for (const entity of seeds.filter((seed) => isCommonRival(seed, everyday))) {
    const lane = commonRivalLane(entity);
    if (lane) lanes.push(lane);
  }
  return lanes;
}

/** The project's own names and its rivals, as the slot filters compare them. */
function excluded(ownNames: string[], rivals: string[]) {
  const names = [...ownNames, ...rivals];
  const exclude = new Set(names.map(slug).filter((name) => name.length >= 3));
  const excludePhrases = names.map((name) => normalizeEntity(name)).filter((name): name is string => Boolean(name?.includes(" ")));
  return { exclude, excludePhrases };
}

/** The seed words, cleaned, without the product's own names or its rivals (rivals have their own place). */
function seedTerms(slots: SeedSlots, ownNames: string[], rivals: string[]) {
  const opts = { ...excluded(ownNames, rivals), dropGeneric: true };
  return { artifacts: slotTerms(slots.artifacts, opts), topics: slotTerms(slots.topics, opts) };
}

/**
 * A project's category/request lanes: one per specific (multi-word) category
 * noun among the first two the seeds name, each ANDed with REQUEST_WORDS.
 * A broad single word ("geo", "leads", "scraping") or a rival is never one.
 * Separate lanes so one broad OR group cannot consume every result page;
 * supplied singular/plural variants stay together in one lane. No new model
 * seeds: the saved noun slots are reused. No filters, so replies are kept.
 */
export function compileRequestLanes(slots: SeedSlots | null, rivals: string[], ownNames: string[]): CompiledLane[] {
  if (!slots) return [];
  const { artifacts, topics } = seedTerms(slots, ownNames, rivals);
  const groups = new Map<string, string[]>();
  for (const term of [...artifacts, ...topics]) {
    if (!term.includes(" ")) continue;
    const key = term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term;
    const group = groups.get(key);
    if (group) {
      if (!group.includes(term)) group.push(term);
    } else if (groups.size < 2) {
      groups.set(key, [term]);
    }
  }
  return [...groups.values()].flatMap((nouns) => {
    const lane = laneOf("request", [nouns, REQUEST_WORDS], ([kept]) => ({ label: `Asking for ${kept[0]}`, seeds: [] }));
    return lane ? [lane] : [];
  });
}

/** REQUEST_WORDS without "alternative(s)": a rival named beside those is the rival lane's. */
export const RIVAL_REQUEST_WORDS = REQUEST_WORDS.filter((term) => term !== "alternative" && term !== "alternatives");

/**
 * The rival-request lane: the coined rivals (the ones compileRivalLanes puts in
 * a shared OR group, never an everyday-word rival such as loom or notion), up
 * to MAX_RIVALS_PER_LANE, ANDed with RIVAL_REQUEST_WORDS. Someone asking which
 * tool to use, by a rival's name: "Best self hosted open source calendly,
 * cal?". Rivals are trimmed to fit, never the words. At most one per project.
 * A request lane, so its posts get buyer screening and replies are kept.
 *
 * In live pilot r84 (2026-10-05..12, five projects, both arms on the same
 * window, blind-graded by Opus 5.5 and GPT-6 Astra) this shape found a
 * consensus-good lead in 4 of 5 projects from 33 screened posts: Cal.com
 * ("Best self hosted open source calendly, cal?"), Tally ("Google forms just
 * wasn't working… suggestions"), Grenseo and Scarlett ("ManyChat as a customer
 * support bot"), the first good leads in that window for Cal.com and ever for
 * Scarlett. The new searches overall found 14 consensus-good leads to the
 * current lanes' 8; a small sample.
 */
export function compileRivalRequestLane(rivals: string[], ordinary: Iterable<string> = []): CompiledLane | null {
  const coined = coinedRivals(rivals, ordinary).slice(0, MAX_RIVALS_PER_LANE);
  if (coined.length === 0) return null;
  return laneOf("request", [coined, RIVAL_REQUEST_WORDS], ([kept]) => ({ label: `Asking about ${listed(kept)}`, seeds: kept }));
}

/**
 * The harness words a project may search in: none that is the product itself
 * or a rival ("n8n" for an automation tool whose rivals are Zapier and Make),
 * comparing a domain name without its suffix, so "make.com" meets "make".
 */
function harnessFor(ownNames: string[], rivals: string[]): string[] {
  const { exclude, excludePhrases } = excluded(ownNames, rivals);
  const bare = (term: string) => slug(term.replace(/\.(?:com|io|ai|dev|app|co)$/u, ""));
  return HARNESS_WORDS.filter((term) => !namesExcluded(term, exclude, excludePhrases) && !exclude.has(bare(term)));
}

/** Word forms shown once in a label: "scraping, scraper" reads as one topic. */
function distinctForms(terms: string[]): string[] {
  const stems = new Set<string>();
  return terms.filter((term) => {
    const stem = term.replace(/(?:ing|ers|er|es|ed|e|s)$/u, "").slice(0, 6);
    if (stems.has(stem)) return false;
    stems.add(stem);
    return true;
  });
}

/**
 * The build-vs-buy lane: the coined rivals and the category's own nouns, bound
 * to the words someone building or replacing their own writes. Rivals that are
 * everyday words stay out: "replaced notion" is a sentence about anything.
 */
export function compileDiyLane(slots: SeedSlots | null, rivals: string[], ownNames: string[]): CompiledLane | null {
  const everyday = everydayNames(slots?.ordinaryWordRivals ?? []);
  const coined = rivals.filter((rival) => !isAmbiguous(rival) && !everyday.has(slug(rival))).slice(0, MAX_DIY_RIVALS);
  const artifacts = slots ? seedTerms(slots, ownNames, rivals).artifacts : [];
  // Rivals and nouns alternate, a rival first, so trimming to fit takes from both
  // and neither is lost whole: "calendly" found Lemkin's Calendly++ post, and
  // "social listening tool" finds a build that names no rival.
  const names: string[] = [];
  for (let index = 0; names.length < MAX_DIY_NAMES && index < Math.max(coined.length, artifacts.length); index += 1) {
    if (coined[index]) names.push(coined[index]);
    if (artifacts[index] && names.length < MAX_DIY_NAMES) names.push(artifacts[index]);
  }
  if (names.length === 0) return null;
  return laneOf(
    "diy",
    [names, DIY_WORDS],
    ([kept]) => {
      const nouns = kept.filter((term) => !coined.includes(term));
      const named = kept.filter((term) => coined.includes(term));
      const label =
        named.length === 0
          ? `Building or replacing their own ${listed(nouns, 2)}`
          : nouns.length === 0
            ? `Building their own ${listed(named)} instead`
            : `Building their own ${nouns[0]}, or replacing ${listed(named)}`;
      return { label, seeds: named };
    },
  );
}

/**
 * The workflow lane: the job's own words in a post written in the tools people
 * build with, top-level and liked by at least STACK_MIN_FAVES, so the post has
 * an audience a reply reaches. Without topics there is no lane: the harness
 * alone is every developer on X.
 */
export function compileStackLane(slots: SeedSlots | null, rivals: string[], ownNames: string[]): CompiledLane | null {
  if (!slots) return null;
  const { topics } = seedTerms(slots, ownNames, rivals);
  const harness = harnessFor(ownNames, rivals);
  if (topics.length === 0 || harness.length < MIN_HARNESS) return null;
  return laneOf(
    "stack",
    [harness, topics],
    ([, kept]) => ({ label: `Popular posts on how people do ${listed(distinctForms(kept), 2)}`, seeds: [] }),
    { topLevelOnly: true, minFaves: STACK_MIN_FAVES },
    1,
  );
}

/**
 * A project's lanes in rank order, which a run capped to its first few (a
 * trial-size dev run) takes them in: the category/request lanes first (they
 * found 12 of 14 good leads in the October 2026 grading), the rival-request
 * lane, then the first rival lane (the buyers), build-vs-buy, the workflow
 * lane, then the other rival lanes. Request lanes share the existing page and
 * judge allowances.
 */
export function orderLanes(
  rival: CompiledLane[],
  diy: CompiledLane | null,
  stack: CompiledLane | null,
  request: CompiledLane[] = [],
  rivalRequest: CompiledLane | null = null,
): CompiledLane[] {
  const [first, ...rest] = rival;
  return [...request, rivalRequest, first, diy, stack, ...rest].filter((lane): lane is CompiledLane => Boolean(lane));
}

/** Every lane for a project, compiled and ordered. */
export function compileLanes(input: { rivals: string[]; slots: SeedSlots | null; ownNames: string[] }): CompiledLane[] {
  const { rivals, slots, ownNames } = input;
  return orderLanes(
    compileRivalLanes(rivals, slots?.ordinaryWordRivals ?? []),
    compileDiyLane(slots, rivals, ownNames),
    compileStackLane(slots, rivals, ownNames),
    compileRequestLanes(slots, rivals, ownNames),
    compileRivalRequestLane(rivals, slots?.ordinaryWordRivals ?? []),
  );
}

/**
 * What the lanes were compiled from. A different hash recompiles them, and a
 * recompile gives every paused lane another chance, so the JSON keeps its keys
 * and their order: `lang` stays in it though it never varies.
 */
export function lanesInputHash(seeds: string[], slots: SeedSlots | null = null, ownNames: string[] = []): string {
  return createHash("sha256").update(JSON.stringify({ v: X_LANES_VERSION, lang: X_LANG, seeds, slots, ownNames })).digest("hex");
}
