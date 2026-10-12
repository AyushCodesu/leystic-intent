import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProductFacts } from "@/lib/product";
import { MAX_LANE_BODY_CHARS, MAX_RIVALS_PER_LANE, X_LANES_VERSION, X_SEEDS_VERSION } from "@/lib/x/constants";
import { assertLane } from "@/lib/x/grammar";
import {
  DIY_WORDS,
  REQUEST_WORDS,
  RIVAL_REQUEST_WORDS,
  everydayNames,
  HARNESS_WORDS,
  RIVAL_WORDS,
  STACK_MIN_FAVES,
  VENUE_FAMILIES,
  bodyOf,
  cleanTerm,
  compileDiyLane,
  compileLanes,
  compileRequestLanes,
  compileRivalLanes,
  compileRivalRequestLane,
  compileStackLane,
  lanesInputHash,
  orderLanes,
  rivalPhrases,
  rivalSeeds,
  type SeedSlots,
} from "@/lib/x/lanes";
import { seedsKey, seedsPrompt } from "@/lib/x/seeds";
import { isAmbiguous, normalizeEntity } from "@/lib/x/words";

/**
 * X search is literal, so code builds every lane from terms, in three
 * families: a coined rival bound to the words people leave or weigh it in
 * (a common-word rival bound only to noun phrases), the category bound to the
 * words someone building their own writes, and the job's words in a popular
 * post written in the tools people build with.
 */
describe("X rival lanes", () => {
  it("binds coined rivals to the words people leave or weigh them in, which covers every old quoted phrase", () => {
    const [lane] = compileRivalLanes(["calendly", "acuity scheduling"]);
    expect(lane.body).toBe(
      `(calendly OR "acuity scheduling") (${RIVAL_WORDS.map((word) => (word.includes(" ") ? `"${word}"` : word)).join(" OR ")}) lang:en -filter:retweets`,
    );
    expect(lane.terms).toEqual([["calendly", "acuity scheduling"], RIVAL_WORDS]);
    expect(lane.family).toBe("rival");
    expect(() => assertLane(`${lane.body} since_time:1790000000`)).not.toThrow();
    // "alternative to calendly" holds both calendly and alternative, so the AND finds it.
    expect(lane.terms[1]).toContain("alternative");
  });

  it("gives a common-word rival its own lane of noun-bound phrases, never a shared group or a bare name", () => {
    expect(isAmbiguous("loom")).toBe(true);
    expect(isAmbiguous("notion")).toBe(true);
    expect(isAmbiguous("tally")).toBe(true);
    expect(isAmbiguous("calendly")).toBe(false);
    expect(isAmbiguous("typeform")).toBe(false);
    const lanes = compileRivalLanes(["loom", "jam"]);
    expect(lanes.map((lane) => lane.body)).toEqual([
      '("alternative to loom" OR "loom alternative" OR "loom alternatives" OR "alternatives to loom") lang:en -filter:retweets',
      '("alternative to jam" OR "jam alternative" OR "jam alternatives" OR "alternatives to jam") lang:en -filter:retweets',
    ]);
    expect(rivalPhrases("loom").every((phrase) => phrase.includes("loom"))).toBe(true);
  });

  it("packs coined rivals up to the rival and length caps, each lane one the guard accepts", () => {
    const rivals = ["calendly", "acuity scheduling", "savvycal", "youcanbook.me", "doodle", "chili piper", "zcal", "tidycal"];
    const lanes = compileRivalLanes(rivals);
    expect(lanes.length).toBeGreaterThan(1);
    for (const lane of lanes) {
      expect(() => assertLane(`${lane.body} since_time:1790000000`)).not.toThrow();
      expect(lane.seeds.length).toBeLessThanOrEqual(6);
    }
    expect(lanes.flatMap((lane) => lane.seeds)).toEqual(rivals.filter((rival) => !isAmbiguous(rival)));
  });

  it("isolates a rival the model calls an everyday word, and quotes a dotted name rather than sending a bare domain", () => {
    const lanes = compileRivalLanes(["calendly", "doodle", "youcanbook.me"], ["Doodle"]);
    expect(lanes.map((lane) => lane.seeds)).toEqual([["calendly", "youcanbook.me"], ["doodle"]]);
    expect(lanes[0].body.startsWith('(calendly OR "youcanbook.me") (alternative OR')).toBe(true);
    expect(lanes[1].body).toBe(
      '("alternative to doodle" OR "doodle alternative" OR "doodle alternatives" OR "alternatives to doodle") lang:en -filter:retweets',
    );
  });

  it("binds rivals to switch and evaluate words, never to a cost or breakage word alone", () => {
    for (const word of ["moving away from", "switched from", "vs", "thoughts on", "is down", "cheaper"]) {
      expect(RIVAL_WORDS).toContain(word);
    }
    for (const word of ["broken", "stopped working", "unreliable", "pricing", "expensive", "overpriced"]) {
      expect(RIVAL_WORDS).not.toContain(word);
    }
  });

  it("never seeds the project's own name, drops unusable names, and keeps standing order", () => {
    expect(rivalSeeds(["Cal.com", "Calendly", "calendly", "  ", "Acuity Scheduling", "21"], ["Cal.com", "cal"])).toEqual([
      "calendly",
      "acuity scheduling",
    ]);
    expect(normalizeEntity('"Notion" (docs)')).toBe("notion docs");
    expect(normalizeEntity("a very long product name that nobody types")).toBeNull();
    expect(normalizeEntity("“Doodle”,")).toBe("doodle");
    expect(normalizeEntity("Yahoo!")).toBe("yahoo");
  });
});

describe("X build-vs-buy and workflow lanes", () => {
  const calcom: SeedSlots = {
    artifacts: ["scheduling tool", "booking page", "tool", "Cal.com", "Calendly clone"],
    topics: ["round robin", "booking link", "scheduling", "app", "calendly"],
    ordinaryWordRivals: ["Doodle"],
    notProducts: [],
  };

  it("binds coined rivals and the category's nouns to the words someone building their own writes", () => {
    const lane = compileDiyLane(calcom, ["calendly", "doodle", "savvycal"], ["Cal.com", "cal"]);
    expect(lane?.family).toBe("diy");
    // The everyday-word rival, a lone generic word, the product's own name and a term naming a rival are left out.
    expect(lane?.terms[0]).toEqual(["calendly", "scheduling tool", "savvycal", "booking page"]);
    expect(lane?.label).toBe("Building their own scheduling tool, or replacing calendly, savvycal");
    expect(lane?.terms[1]).toEqual(DIY_WORDS);
    expect(lane?.seeds).toEqual(["calendly", "savvycal"]);
    expect(lane?.body.endsWith(" lang:en -filter:retweets")).toBe(true);
    expect(() => assertLane(`${lane?.body} since_time:1790000000`)).not.toThrow();
  });

  it("keeps room for the category's nouns beside many rivals, and never trims the fixed words to fit", () => {
    const rivals = ["apify", "bright data", "ensembledata", "firecrawl", "hikerapi", "oxylabs", "proxycurl", "rapidapi", "zenrows"];
    const long = ["scraping api platform", "social data api", "instagram scraper tool", "tiktok data provider", "serp api service", "profile enrichment api", "lead data provider", "web scraping service"];
    const lane = compileDiyLane({ artifacts: long, topics: [] }, rivals, []);
    expect(lane?.terms[1]).toEqual(DIY_WORDS);
    expect(lane?.terms[0].some((term) => long.includes(term))).toBe(true);
    expect(lane?.seeds.every((rival) => lane.terms[0].includes(rival))).toBe(true);
    // The label names only words the query holds.
    const labelled = lane!.label.match(/their own ([^,]+),/u)?.[1];
    expect(lane?.terms[0]).toContain(labelled);
    const stack = compileStackLane({ artifacts: [], topics: long }, [], []);
    expect(stack?.terms[0]).toEqual(HARNESS_WORDS);
    expect(stack!.body.length).toBeLessThanOrEqual(380);
  });

  it("keeps both the rivals and the nouns when the query must be trimmed to fit", () => {
    const artifacts = ["scheduling tool", "scheduling tools", "booking page", "booking pages", "booking link", "calendar booking tool"];
    const lane = compileDiyLane({ artifacts, topics: [] }, ["calendly", "savvycal", "acuity scheduling"], []);
    expect(lane?.terms[0]).toContain("calendly");
    expect(lane?.terms[0]).toContain("scheduling tool");
    expect(lane!.body.length).toBeLessThanOrEqual(380);
  });

  it("leaves the product's own tools and its rivals out of the workflow lane's harness", () => {
    const lane = compileStackLane(calcom, ["zapier", "make"], ["n8n"]);
    expect(lane?.terms[0]).not.toContain("zapier");
    expect(lane?.terms[0]).not.toContain("make.com");
    expect(lane?.terms[0]).not.toContain("n8n");
    expect(lane?.terms[0]).toContain("claude code");
  });

  it("keeps a dotted name coined whatever the model called it", () => {
    expect([...everydayNames(["Doodle", "context.dev", "Otterly.AI", "Chaser"])].sort()).toEqual(["chaser", "doodle"]);
    const lanes = compileRivalLanes(["apify", "context.dev"], ["context.dev"]);
    expect(lanes.map((one) => one.seeds)).toEqual([["apify", "context.dev"]]);
  });

  it("labels a lane with no rivals, and a workflow lane, in words that read", () => {
    expect(compileDiyLane({ artifacts: ["form builder", "form builders"], topics: [] }, [], [])?.label).toBe(
      "Building or replacing their own form builder, form builders",
    );
    expect(compileStackLane({ artifacts: [], topics: ["scraping", "scrape", "scraper", "scrapers", "tiktok data"] }, [], [])?.label).toBe(
      "Popular posts on how people do scraping, tiktok data",
    );
  });

  it("makes a build-vs-buy lane from rivals alone, or from nouns alone, and none from neither", () => {
    expect(compileDiyLane(null, ["calendly"], [])?.terms[0]).toEqual(["calendly"]);
    expect(compileDiyLane({ artifacts: ["scheduling tool", "booking page"], topics: [] }, [], [])?.terms[0]).toEqual([
      "scheduling tool",
      "booking page",
    ]);
    expect(compileDiyLane({ artifacts: ["app"], topics: [] }, ["loom"], [])).toBeNull();
  });

  it("binds the job's words to the tools people build with, top-level posts with reach only", () => {
    const lane = compileStackLane(calcom, ["calendly"], ["Cal.com"]);
    expect(lane?.family).toBe("stack");
    expect(lane?.terms).toEqual([HARNESS_WORDS, ["round robin", "booking link", "scheduling"]]);
    expect(lane?.body.endsWith(` lang:en -filter:retweets -filter:replies min_faves:${STACK_MIN_FAVES}`)).toBe(true);
    expect(() => assertLane(`${lane?.body} since_time:1790000000`)).not.toThrow();
  });

  it("makes no workflow lane without topics: the tools alone are every developer on X", () => {
    expect(compileStackLane({ ...calcom, topics: ["app", "tool"] }, [], [])).toBeNull();
    expect(compileStackLane(null, ["calendly"], [])).toBeNull();
  });

  it("reads venue families as the ones whose posts can be worth a reply without an ask", () => {
    expect(VENUE_FAMILIES.has("diy")).toBe(true);
    expect(VENUE_FAMILIES.has("stack")).toBe(true);
    expect(VENUE_FAMILIES.has("rival")).toBe(false);
  });

  it("trims the largest group until the lane fits, so a long slot still makes a lane", () => {
    const topics = Array.from({ length: 8 }, (_, index) => `topic${index} long phrase`);
    const lane = compileStackLane({ artifacts: [], topics }, [], []);
    expect(lane?.body.length).toBeLessThanOrEqual(380);
    expect(() => assertLane(lane!.body)).not.toThrow();
  });

  it("cleans a term into something a lane can hold, or refuses it", () => {
    expect(cleanTerm('  "Google  Maps" ')).toBe("google maps");
    expect(cleanTerm("context.dev")).toBe("context.dev");
    expect(cleanTerm("x")).toBeNull();
    expect(cleanTerm("1000")).toBeNull();
    expect(cleanTerm("or")).toBeNull();
    expect(cleanTerm("back and forth")).toBe("back and forth");
    expect(cleanTerm("client won’t pay")).toBe("client won't pay");
    expect(cleanTerm("one two three four five")).toBeNull();
    expect(cleanTerm("from:someone")).toBe("from someone");
  });
});

describe("X lane order and inputs", () => {
  it("puts the request lanes first, then the rival-request lane, the first rival lane, build-vs-buy and workflow, so a run capped to its first few lanes gets one of each", () => {
    const slots: SeedSlots = { artifacts: ["scraping api"], topics: ["scraping", "scraper"] };
    const rivals = ["apify", "bright data", "firecrawl", "oxylabs", "proxycurl", "rapidapi", "scraperapi", "loom"];
    const lanes = compileLanes({ rivals, slots, ownNames: ["AnyAPI"] });
    expect(lanes.slice(0, 5).map((lane) => lane.family)).toEqual(["request", "request", "rival", "diy", "stack"]);
    expect(lanes[1].label.startsWith("Asking about apify")).toBe(true);
    expect(lanes.slice(5).every((lane) => lane.family === "rival")).toBe(true);
    expect(orderLanes([], null, null)).toEqual([]);
    expect(compileLanes({ rivals: [], slots: null, ownNames: [] })).toEqual([]);
  });

  it("writes a single-alternative group bare, a phrase quoted, and the filters in the tail's order", () => {
    expect(bodyOf([["firecrawl"], ["expensive", "ran out"]])).toBe('firecrawl (expensive OR "ran out") lang:en -filter:retweets');
    expect(bodyOf([["n8n"]], { topLevelOnly: true, minFaves: 20 })).toBe("n8n lang:en -filter:retweets -filter:replies min_faves:20");
  });

  it("changes the input hash when the rivals, the seed words or the own names change", () => {
    const base = lanesInputHash(["calendly"]);
    expect(lanesInputHash(["calendly"])).toBe(base);
    expect(lanesInputHash(["calendly", "doodle"])).not.toBe(base);
    expect(lanesInputHash(["calendly"], { artifacts: ["booking page"], topics: [] })).not.toBe(base);
    expect(lanesInputHash(["calendly"], null, ["Cal.com"])).not.toBe(base);
  });

  it("hashes the same JSON every stored hash was made from, so no lane recompiles", () => {
    const slots: SeedSlots = { artifacts: ["booking page"], topics: ["scheduling"] };
    const stored = JSON.stringify({ v: X_LANES_VERSION, lang: "en", seeds: ["calendly"], slots, ownNames: ["Cal.com"] });
    expect(lanesInputHash(["calendly"], slots, ["Cal.com"])).toBe(createHash("sha256").update(stored).digest("hex"));
  });

  it("asks for seed words with the same prompt every cached key was made from, so no project buys them again", () => {
    const product: ProductFacts = {
      name: "Cal.com",
      url: null,
      pain: "",
      solution: "",
      targetUsers: "",
      serviceGeography: "",
      budgetFit: "",
      capabilities: [],
      exclusions: [],
      notBuyers: [],
      competitors: [],
    };
    const prompt = seedsPrompt(product, ["book a meeting", "google calendar api"], ["savvycal", "calendly"]);
    const stored = JSON.stringify({
      product: { name: "Cal.com", competitors: ["calendly", "savvycal"] },
      how_buyers_say_it: ["book a meeting"],
      platforms_it_gets_data_from: ["google calendar"],
      language: "en",
    });
    expect(prompt).toBe(stored);
    // The language stays in the prompt, last, though it never varies: the cached key is a hash of this text.
    expect(JSON.parse(prompt).language).toBe("en");
    expect(Object.keys(JSON.parse(prompt)).at(-1)).toBe("language");
    expect(seedsKey(prompt)).toBe(createHash("sha256").update(JSON.stringify({ v: X_SEEDS_VERSION, prompt: stored })).digest("hex"));
  });
});

describe("X category request lanes", () => {
  it("separates the first two specific categories, keeping a noun's plural with it", () => {
    const lanes = compileRequestLanes({ artifacts: ["screen recorder", "screen recorders", "screen recording", "screen recordings", "bug report video"], topics: ["ui bug"] }, [], []);
    expect(lanes.map((lane) => lane.terms[0])).toEqual([["screen recorder", "screen recorders"], ["screen recording", "screen recordings"]]);
    expect(lanes.every((lane) => lane.terms[1].join() === REQUEST_WORDS.join())).toBe(true);
    expect(lanes.map((lane) => lane.label)).toEqual(["Asking for screen recorder", "Asking for screen recording"]);
  });

  it("needs a specific multi-word category, never a broad word or a rival, and keeps replies", () => {
    const lanes = compileRequestLanes({ artifacts: ["app", "geo", "calendly clone", "ai visibility tracker", "ai visibility trackers"], topics: ["geo"] }, ["calendly"], []);
    expect(lanes.map((lane) => lane.terms[0])).toEqual([["ai visibility tracker", "ai visibility trackers"]]);
    const [lane] = lanes;
    expect(lane.family).toBe("request");
    expect(lane.seeds).toEqual([]);
    expect(() => assertLane(lane.body)).not.toThrow();
    expect(lane.body).not.toContain("-filter:replies");
    expect(lane.body).not.toContain("min_faves");
    expect(compileRequestLanes({ artifacts: ["tool", "scraping"], topics: ["scraping"] }, [], [])).toEqual([]);
    expect(compileRequestLanes(null, [], [])).toEqual([]);
  });

  it("is a buyer family, not a venue, so its posts get normal buyer screening and judging", () => {
    expect(VENUE_FAMILIES.has("request")).toBe(false);
  });

  it("orders request lanes before the first rival lane", () => {
    const [rival] = compileRivalLanes(["apify"]);
    const request = compileRequestLanes({ artifacts: ["booking page", "scheduling link"], topics: [] }, [], []);
    expect(orderLanes([rival], null, null, request).map((lane) => lane.family)).toEqual(["request", "request", "rival"]);
    expect(orderLanes([rival], null, null)).toEqual([rival]);
  });
});

describe("X rival-request lane", () => {
  it("asks about the coined rivals with the request words, and no alternative words", () => {
    const lane = compileRivalRequestLane(["calendly", "savvycal", "youcanbook.me"]);
    expect(lane).not.toBeNull();
    expect(lane!.family).toBe("request");
    expect(lane!.terms).toEqual([["calendly", "savvycal", "youcanbook.me"], RIVAL_REQUEST_WORDS]);
    expect(lane!.seeds).toEqual(["calendly", "savvycal", "youcanbook.me"]);
    expect(lane!.label).toBe("Asking about calendly, savvycal, youcanbook.me");
    expect(RIVAL_REQUEST_WORDS).toEqual(REQUEST_WORDS.filter((term) => !term.startsWith("alternative")));
    expect(lane!.body).not.toMatch(/alternative/u);
    expect(lane!.body).not.toContain("-filter:replies");
    expect(() => assertLane(lane!.body)).not.toThrow();
  });

  it("is built from the same coined rivals the shared rival group holds, never an everyday-word rival", () => {
    const rivals = ["loom", "calendly", "jam", "doodle", "intercom", "notion", "savvycal"];
    const lane = compileRivalRequestLane(rivals, ["doodle"]);
    const shared = compileRivalLanes(rivals, ["doodle"]).filter((one) => one.terms[1]?.join() === RIVAL_WORDS.join());
    expect(lane!.seeds).toEqual(["calendly", "savvycal"]);
    expect(lane!.seeds).toEqual(shared.flatMap((one) => one.seeds));
    for (const common of ["loom", "jam", "doodle", "intercom", "notion"]) expect(lane!.terms[0]).not.toContain(common);
  });

  it("takes at most MAX_RIVALS_PER_LANE rivals and trims rivals, never words, to fit the body limit", () => {
    const many = Array.from({ length: 12 }, (_, i) => `rivalname${i}`);
    expect(compileRivalRequestLane(many)!.seeds).toHaveLength(MAX_RIVALS_PER_LANE);
    const long = Array.from({ length: 6 }, (_, i) => `averyveryverylongcoinedbrandname${i}x`);
    const lane = compileRivalRequestLane(long)!;
    expect(lane.body.length).toBeLessThanOrEqual(MAX_LANE_BODY_CHARS);
    expect(lane.terms[0].length).toBeLessThan(long.length);
    expect(lane.terms[1]).toEqual(RIVAL_REQUEST_WORDS);
    expect(lane.label).toMatch(/…$/u);
  });

  it("is null when no rival is coined", () => {
    expect(compileRivalRequestLane([])).toBeNull();
    expect(compileRivalRequestLane(["loom", "notion"], ["loom", "notion"])).toBeNull();
    expect(compileLanes({ rivals: ["loom"], slots: { artifacts: [], topics: [], ordinaryWordRivals: ["loom"] }, ownNames: [] }).map((one) => one.family)).toEqual(["rival"]);
  });

  it("comes after the category request lanes and before the first rival lane, one per project", () => {
    const lanes = compileLanes({ rivals: ["calendly", "savvycal", "doodle"], slots: { artifacts: ["booking page"], topics: [], ordinaryWordRivals: ["doodle"] }, ownNames: ["Cal.com"] });
    expect(lanes.map((one) => [one.family, one.label])).toEqual(
      expect.arrayContaining([["request", "Asking for booking page"], ["request", "Asking about calendly, savvycal"]]),
    );
    expect(lanes.slice(0, 3).map((one) => one.label)).toEqual(["Asking for booking page", "Asking about calendly, savvycal", "Leaving or weighing calendly, savvycal"]);
    expect(lanes.filter((one) => one.label.startsWith("Asking about"))).toHaveLength(1);
    const [rival] = compileRivalLanes(["apify"]);
    const rivalRequest = compileRivalRequestLane(["apify"]);
    expect(orderLanes([rival], null, null, [], rivalRequest)).toEqual([rivalRequest, rival]);
  });
});
