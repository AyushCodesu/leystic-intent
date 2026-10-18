import { beforeEach, describe, expect, it, vi } from "vitest";
import { competitorHost, domainRoot, matchCompetitorDomain } from "@/lib/competitors/host";
import { TIERS } from "@/lib/tiers";

const generateStructured = vi.fn();

vi.mock("@/lib/llm", () => ({ generateStructured }));
vi.mock("@/db", () => ({ db: () => ({}) }));

const {
  OTHER_COMPETITORS,
  mentionSeries,
  stackMentions,
  topCompetitors,
  groupLoveReasons,
  groupDislikeReasons,
  listPotentialSwitchers,
} = await import("@/lib/competitors/read");
const {
  classifyMentions,
  reasonCategorySchema,
  switchingEvidenceSchema,
} = await import("@/lib/competitors/classify");
const { keepMentions } = await import("@/lib/competitors/scan");
const { capped } = await import("@/lib/tier");
const { competitorsNamed, quoteNaming } = await import("@/lib/competitors/match");
const { threadMentions, competitorsInThread } = await import("@/lib/competitors/threads");

describe("competitor cap", () => {
  const names = ["Typeform", "Jotform", "Tally", "Fillout"];

  it("watches only as many competitors as the free tier allows", () => {
    expect(capped(names, TIERS.free.competitors)).toEqual(["Typeform", "Jotform", "Tally"]);
    expect(TIERS.free.competitors).toBe(3);
  });

  it("caps nothing for a connected wallet or a self-hosted instance", () => {
    expect(capped(names, TIERS.connected.competitors)).toEqual(names);
    // A self-hosted instance has no limits at all, so the cap it reads is undefined.
    expect(capped(names, undefined)).toEqual(names);
  });
});

describe("competitor host", () => {
  it("uses a favicon only when the name is a domain", () => {
    expect(competitorHost("typeform.com")).toBe("typeform.com");
    expect(competitorHost("https://www.jotform.com/pricing")).toBe("jotform.com");
    expect(competitorHost("Docs.Google.com")).toBe("docs.google.com");
  });

  it("falls back to initials for a plain product name", () => {
    expect(competitorHost("Typeform")).toBeNull();
    expect(competitorHost("Google Forms")).toBeNull();
    expect(competitorHost("")).toBeNull();
    expect(competitorHost("survey.")).toBeNull();
  });
});

describe("the label a brand owns", () => {
  it("reads past the subdomain and past a two-part suffix", () => {
    expect(domainRoot("typeform.com")).toBe("typeform");
    expect(domainRoot("app.typeform.com")).toBe("typeform");
    expect(domainRoot("typeform.co.uk")).toBe("typeform");
  });
});

describe("pairing a competitor with its site", () => {
  const seen = ["typeform.com", "www.hoteltonight.com", "old.reddit.com"];

  it("takes a name that is already a domain as its own answer", () => {
    expect(matchCompetitorDomain("Jotform.com", ["typeform.com"])).toBe("jotform.com");
  });

  it("finds the site a name spells, punctuation and case aside", () => {
    expect(matchCompetitorDomain("Typeform", seen)).toBe("typeform.com");
    expect(matchCompetitorDomain("Hotel Tonight", seen)).toBe("hoteltonight.com");
  });

  it("gives no site to a name nothing in the evidence matched", () => {
    expect(matchCompetitorDomain("Google Forms", seen)).toBeNull();
    expect(matchCompetitorDomain("Tally", [])).toBeNull();
    expect(matchCompetitorDomain("   ", seen)).toBeNull();
  });
});

describe("sentiment classification", () => {
  beforeEach(() => {
    generateStructured.mockReset();
  });

  it("keeps one verdict per post it sent", async () => {
    generateStructured.mockResolvedValue({
      mentions: [
        {
          id: "p1",
          about: "the_product",
          sentiment: "negative",
          summary: " Leaving after a price rise ",
          reasonCategory: "pricing_value",
          switchingEvidence: "actively_switching",
          explanation: "Author is leaving after a price hike",
        },
        {
          id: "p2",
          about: "the_product",
          sentiment: "positive",
          summary: "Recommends it",
          reasonCategory: "usability",
          switchingEvidence: "positive_recommendation",
          explanation: "Happy with usability",
        },
      ],
    });
    const verdicts = await classifyMentions("project-1", "Typeform", [
      { id: "p1", title: "Done with it", subreddit: "SaaS", body: "the new price" },
      { id: "p2", title: "Works well", subreddit: "SaaS", body: "happy" },
    ]);
    expect(generateStructured.mock.calls[0][0].purpose).toBe("competitors");
    expect(verdicts.get("p1")).toEqual({
      about: "the_product",
      sentiment: "negative",
      summary: "Leaving after a price rise",
      reasonCategory: "pricing_value",
      switchingEvidence: "actively_switching",
      explanation: "Author is leaving after a price hike",
    });
    expect(verdicts.get("p2")?.sentiment).toBe("positive");
    expect(verdicts.get("p2")?.reasonCategory).toBe("usability");
  });

  it("drops an answer about a post it never sent, and a repeat", async () => {
    generateStructured.mockResolvedValue({
      mentions: [
        {
          id: "p1",
          about: "the_product",
          sentiment: "neutral",
          summary: "First",
          reasonCategory: "unknown",
          switchingEvidence: "no_clear_signal",
          explanation: "First",
        },
        {
          id: "p1",
          about: "in_passing",
          sentiment: "positive",
          summary: "Second",
          reasonCategory: "unknown",
          switchingEvidence: "no_clear_signal",
          explanation: "Second",
        },
        {
          id: "ghost",
          about: "the_product",
          sentiment: "positive",
          summary: "Never sent",
          reasonCategory: "unknown",
          switchingEvidence: "no_clear_signal",
          explanation: "Never sent",
        },
      ],
    });
    const verdicts = await classifyMentions("project-1", "Typeform", [
      { id: "p1", title: "Asking", subreddit: "SaaS", body: "which one" },
    ]);
    expect([...verdicts.keys()]).toEqual(["p1"]);
    expect(verdicts.get("p1")?.summary).toBe("First");
  });

  it("asks nothing when there are no posts", async () => {
    expect((await classifyMentions("project-1", "Typeform", [])).size).toBe(0);
    expect(generateStructured).not.toHaveBeenCalled();
  });
});

describe("switching evidence schema normalization", () => {
  it("normalizes explicit switching evidence aliases", () => {
    expect(switchingEvidenceSchema.parse("actively_switching")).toBe("actively_switching");
    expect(switchingEvidenceSchema.parse("actively switching")).toBe("actively_switching");
    expect(switchingEvidenceSchema.parse("migrating away")).toBe("actively_switching");
    expect(switchingEvidenceSchema.parse("migrating off")).toBe("actively_switching");
    expect(switchingEvidenceSchema.parse("migrated")).toBe("actively_switching");
    expect(switchingEvidenceSchema.parse("cancelled our subscription")).toBe("actively_switching");
    expect(switchingEvidenceSchema.parse("canceled subscription")).toBe("actively_switching");
    expect(switchingEvidenceSchema.parse("switching away")).toBe("actively_switching");
    expect(switchingEvidenceSchema.parse("evaluating alternatives")).toBe("evaluating_alternatives");
    expect(switchingEvidenceSchema.parse("evaluating options")).toBe("evaluating_alternatives");
    expect(switchingEvidenceSchema.parse("looking for replacement")).toBe("evaluating_alternatives");
    expect(switchingEvidenceSchema.parse("seeking alternatives")).toBe("evaluating_alternatives");
    expect(switchingEvidenceSchema.parse("considering alternatives")).toBe("evaluating_alternatives");
    expect(switchingEvidenceSchema.parse("dissatisfied without switching evidence")).toBe("dissatisfied_no_switch");
    expect(switchingEvidenceSchema.parse("dissatisfied")).toBe("dissatisfied_no_switch");
    expect(switchingEvidenceSchema.parse("complaint")).toBe("dissatisfied_no_switch");
    expect(switchingEvidenceSchema.parse("positive recommendation")).toBe("positive_recommendation");
    expect(switchingEvidenceSchema.parse("recommendation")).toBe("positive_recommendation");
    expect(switchingEvidenceSchema.parse("satisfied")).toBe("positive_recommendation");
    expect(switchingEvidenceSchema.parse("no clear signal")).toBe("no_clear_signal");
  });

  it("safely handles negation and staying wording as no_clear_signal rather than actively_switching", () => {
    expect(switchingEvidenceSchema.parse("not switching")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("not leaving")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("we cannot switch")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("cannot switch")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("can't switch")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("won't switch")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("wont switch")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("never switch")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("staying despite the issues")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("staying")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("not actively switching")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("will not switch")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("no switch")).toBe("no_clear_signal");
  });

  it("handles ambiguous, contradictory, or unsupported text by defaulting to no_clear_signal", () => {
    expect(switchingEvidenceSchema.parse("not sure if we will leave")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("random string that mentions nothing")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse(null)).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse(undefined)).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse(123)).toBe("no_clear_signal");
  });
});

describe("reason category schema normalization", () => {
  it("normalizes explicit reason category aliases", () => {
    expect(reasonCategorySchema.parse("pricing_value")).toBe("pricing_value");
    expect(reasonCategorySchema.parse("pricing / value")).toBe("pricing_value");
    expect(reasonCategorySchema.parse("expensive")).toBe("pricing_value");
    expect(reasonCategorySchema.parse("missing feature")).toBe("missing_capability");
    expect(reasonCategorySchema.parse("capability limitation")).toBe("missing_capability");
    expect(reasonCategorySchema.parse("clunky ui")).toBe("usability");
    expect(reasonCategorySchema.parse("confusing workflow")).toBe("usability");
    expect(reasonCategorySchema.parse("uptime")).toBe("reliability");
    expect(reasonCategorySchema.parse("bugs")).toBe("reliability");
    expect(reasonCategorySchema.parse("slow")).toBe("performance");
    expect(reasonCategorySchema.parse("latency")).toBe("performance");
    expect(reasonCategorySchema.parse("zapier")).toBe("integrations");
    expect(reasonCategorySchema.parse("webhook")).toBe("integrations");
    expect(reasonCategorySchema.parse("customer support")).toBe("support");
    expect(reasonCategorySchema.parse("documentation")).toBe("support");
    expect(reasonCategorySchema.parse("value delivered")).toBe("recommendation_value_delivered");
    expect(reasonCategorySchema.parse("endorsement")).toBe("recommendation_value_delivered");
  });

  it("defaults unsupported reason categories to unknown", () => {
    expect(reasonCategorySchema.parse("unsupported reason")).toBe("unknown");
    expect(reasonCategorySchema.parse("")).toBe("unknown");
    expect(reasonCategorySchema.parse(null)).toBe("unknown");
    expect(reasonCategorySchema.parse(undefined)).toBe("unknown");
    expect(reasonCategorySchema.parse(42)).toBe("unknown");
  });
});

describe("only posts about the competitor are stored", () => {
  it("keeps a post the writer is using or leaving, and drops a passing link", () => {
    const kept = keepMentions(
      new Map([
        [
          "p1",
          {
            about: "the_product",
            sentiment: "negative",
            summary: "Leaving it",
            reasonCategory: "pricing_value",
            switchingEvidence: "actively_switching",
            explanation: "Leaving due to pricing",
          } as const,
        ],
        [
          "p2",
          {
            about: "in_passing",
            sentiment: "neutral",
            summary: "Shares a Typeform link to RSVP for a French cafe meetup",
            reasonCategory: "unknown",
            switchingEvidence: "no_clear_signal",
            explanation: "Passing link",
          } as const,
        ],
        [
          "p3",
          {
            about: "in_passing",
            sentiment: "neutral",
            summary: "Shared a Google Forms link to vote for favorite songs",
            reasonCategory: "unknown",
            switchingEvidence: "no_clear_signal",
            explanation: "Passing link",
          } as const,
        ],
      ]),
    );
    expect([...kept.keys()]).toEqual(["p1"]);
  });
});

describe("top competitors", () => {
  it("orders by total mentions and splits each by sentiment", () => {
    const counts = topCompetitors([
      { competitor: "Jotform", sentiment: "positive" },
      { competitor: "Typeform", sentiment: "negative" },
      { competitor: "Typeform", sentiment: "negative" },
      { competitor: "Typeform", sentiment: "neutral" },
    ]);
    expect(counts.map((row) => row.competitor)).toEqual(["Typeform", "Jotform"]);
    expect(counts[0].total).toBe(3);
    expect(counts[0].sentiments).toEqual({ positive: 0, neutral: 1, negative: 2 });
    expect(counts[1].sentiments).toEqual({ positive: 1, neutral: 0, negative: 0 });
  });

  it("counts nothing when there are no mentions", () => {
    expect(topCompetitors([])).toEqual([]);
  });
});

describe("mentions over time", () => {
  const now = new Date("2026-09-05T12:00:00Z");

  it("puts each mention in its own day and keeps a competitor with none", () => {
    const series = mentionSeries(
      [
        { competitor: "Typeform", createdAt: new Date("2026-09-05T09:00:00Z") },
        { competitor: "Typeform", createdAt: new Date("2026-09-05T10:00:00Z") },
        { competitor: "Typeform", createdAt: new Date("2026-08-27T10:00:00Z") },
      ],
      ["Typeform", "Jotform"],
      30,
      now,
    );
    const typeform = series.find((row) => row.competitor === "Typeform");
    expect(typeform?.days).toHaveLength(30);
    expect(typeform?.total).toBe(3);
    // Newest first, so the two from today are the first bar and the one from
    // nine days ago is the tenth.
    expect(typeform?.days[0]).toBe(2);
    expect(typeform?.days[9]).toBe(1);
    expect(series.find((row) => row.competitor === "Jotform")?.total).toBe(0);
  });

  it("ignores a mention older than the window", () => {
    const series = mentionSeries(
      [{ competitor: "Typeform", createdAt: new Date("2026-01-01T00:00:00Z") }],
      ["Typeform"],
      30,
      now,
    );
    expect(series[0].total).toBe(0);
  });
});

describe("stacking the mentions into one bar per day", () => {
  /** A row as `mentionSeries` hands it over: one number per day, newest first. */
  function row(competitor: string, days: number[]) {
    return { competitor, days, total: days.reduce((sum, one) => sum + one, 0) };
  }

  it("keeps the project's own order and measures the busiest day", () => {
    const { rows, peak } = stackMentions([
      row("Typeform", [2, 0, 1]),
      row("Jotform", [3, 0, 0]),
    ]);
    expect(rows.map((one) => one.competitor)).toEqual(["Typeform", "Jotform"]);
    expect(rows.map((one) => one.slot)).toEqual([1, 2]);
    // Five on the first day, not three: the peak is the whole stack's height.
    expect(peak).toBe(5);
  });

  it("drops a competitor nobody named without moving anyone's colour", () => {
    const { rows } = stackMentions([
      row("Typeform", [1]),
      row("Jotform", [0]),
      row("Tally", [2]),
    ]);
    expect(rows.map((one) => one.competitor)).toEqual(["Typeform", "Tally"]);
    // Tally keeps slot 3. Sliding it into the gap would repaint the chart on
    // the week Jotform happens to go quiet.
    expect(rows.map((one) => one.slot)).toEqual([1, 3]);
  });

  it("adds everyone past the eighth name together into one grey row", () => {
    const named = Array.from({ length: 8 }, (_, index) => row(`Rival ${index + 1}`, [1, 0]));
    const { rows, peak } = stackMentions([...named, row("Ninth", [1, 2]), row("Tenth", [0, 3])]);
    expect(rows).toHaveLength(9);
    const folded = rows[8];
    expect(folded.competitor).toBe(OTHER_COMPETITORS);
    expect(folded.days).toEqual([1, 5]);
    expect(folded.total).toBe(6);
    // Null is what tells the chart to draw it grey rather than as a ninth hue.
    expect(folded.slot).toBeNull();
    expect(peak).toBe(9);
  });

  it("draws nothing, and never divides by zero, on a silent window", () => {
    const { rows, peak } = stackMentions([row("Typeform", [0, 0, 0])]);
    expect(rows).toEqual([]);
    expect(peak).toBe(1);
  });
});

describe("competitors named in a thread", () => {
  const post = {
    id: "p1",
    title: "Which form builder?",
    body: "We are on Google Forms and it is not enough.",
  } as never as import("@/lib/reddit/store").StoredPost;

  function reply(id: string, body: string) {
    return { id, postId: "p1", author: "helper", body } as never as import("@/lib/reddit/store").StoredComment;
  }

  it("matches a name however a redditor writes it, each once", () => {
    expect(competitorsNamed(["Typeform", "Tally"], "typeform beats TYPEFORM for me")).toEqual([
      "Typeform",
    ]);
    expect(competitorsNamed(["  ", "Tally"], "anything")).toEqual([]);
  });

  it("quotes the sentence that named the competitor", () => {
    expect(quoteNaming("Skip Jotform. Honestly just use Typeform, it has logic.", "typeform")).toBe(
      "Honestly just use Typeform, it has logic.",
    );
    expect(quoteNaming("No product here.", "Typeform")).toBeNull();
  });

  it("names a competitor in the post, and each one a reply recommends", () => {
    const rows = threadMentions("proj", ["Typeform", "Google Forms", "Tally"], {
      post,
      comments: [reply("c1", "Try Typeform or Tally."), reply("c2", "Typeform again.")],
    });
    expect(rows.map((row) => [row.competitor, row.commentId])).toEqual([
      ["Google Forms", null],
      ["Typeform", "c1"],
      ["Tally", "c1"],
      ["Typeform", "c2"],
    ]);
    expect(rows[1].quote).toBe("Try Typeform or Tally.");
    expect(
      competitorsInThread(["Typeform", "Google Forms", "Tally"], {
        post,
        comments: [reply("c1", "Try Typeform or Tally.")],
      }),
    ).toEqual(["Typeform", "Google Forms", "Tally"]);
  });

  it("counts a mention with no sentiment in the total only", () => {
    const counts = topCompetitors([
      { competitor: "Typeform", sentiment: null },
      { competitor: "Typeform", sentiment: "negative" },
    ]);
    expect(counts[0].total).toBe(2);
    expect(counts[0].sentiments).toEqual({ positive: 0, neutral: 0, negative: 1 });
  });
});

describe("reason and switching normalization schemas", () => {
  it("normalizes standard reason category strings and loose phrasing", () => {
    expect(reasonCategorySchema.parse("pricing_value")).toBe("pricing_value");
    expect(reasonCategorySchema.parse("pricing/value")).toBe("pricing_value");
    expect(reasonCategorySchema.parse("Too high price")).toBe("pricing_value");
    expect(reasonCategorySchema.parse("Expensive subscription cost")).toBe("pricing_value");
    expect(reasonCategorySchema.parse("missing feature")).toBe("missing_capability");
    expect(reasonCategorySchema.parse("complex UX / confusing flow")).toBe("usability");
    expect(reasonCategorySchema.parse("system crashes and downtime")).toBe("reliability");
    expect(reasonCategorySchema.parse("slow page load times")).toBe("performance");
    expect(reasonCategorySchema.parse("zapier webhook integration")).toBe("integrations");
    expect(reasonCategorySchema.parse("support team ticket delay")).toBe("support");
    expect(reasonCategorySchema.parse("great tool love it")).toBe("recommendation_value_delivered");
    expect(reasonCategorySchema.parse("other reason")).toBe("other");
    expect(reasonCategorySchema.parse("random unparseable gibberish")).toBe("unknown");
    expect(reasonCategorySchema.parse(null)).toBe("unknown");
  });

  it("normalizes switching evidence and distinguishes dissatisfaction from switching", () => {
    expect(switchingEvidenceSchema.parse("actively_switching")).toBe("actively_switching");
    expect(switchingEvidenceSchema.parse("actively switching")).toBe("actively_switching");
    expect(switchingEvidenceSchema.parse("migrated to another tool")).toBe("actively_switching");
    expect(switchingEvidenceSchema.parse("cancelled subscription")).toBe("actively_switching");
    expect(switchingEvidenceSchema.parse("evaluating_alternatives")).toBe("evaluating_alternatives");
    expect(switchingEvidenceSchema.parse("looking for alternative")).toBe("evaluating_alternatives");
    expect(switchingEvidenceSchema.parse("considering replacement")).toBe("evaluating_alternatives");
    expect(switchingEvidenceSchema.parse("dissatisfied_no_switch")).toBe("dissatisfied_no_switch");
    expect(switchingEvidenceSchema.parse("frustrated with bug")).toBe("dissatisfied_no_switch");
    expect(switchingEvidenceSchema.parse("positive_recommendation")).toBe("positive_recommendation");
    expect(switchingEvidenceSchema.parse("recommends product")).toBe("positive_recommendation");
    expect(switchingEvidenceSchema.parse("no_clear_signal")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse("unclear")).toBe("no_clear_signal");
    expect(switchingEvidenceSchema.parse(undefined)).toBe("no_clear_signal");
  });
});

describe("grouping love reasons", () => {
  const baseDate = new Date("2026-09-01T10:00:00Z");
  function makeMention(
    overrides: Partial<import("@/lib/competitors/read").MentionView>,
  ): import("@/lib/competitors/read").MentionView {
    return {
      id: "m1",
      competitor: "Typeform",
      sentiment: "positive",
      summary: "Loved the UX",
      quote: "Typeform is so easy to use",
      reasonCategory: "usability",
      switchingEvidence: "positive_recommendation",
      explanation: "Great usability praised by user",
      foundAt: baseDate,
      postId: "p1",
      title: "Best form builder?",
      url: "https://reddit.com/r/SaaS/comments/p1",
      subreddit: "SaaS",
      subredditIconUrl: null,
      author: "user1",
      avatarUrl: null,
      createdAt: baseDate,
      ...overrides,
    };
  }

  it("counts distinct threads rather than inflating reply counts", () => {
    const mentions = [
      makeMention({ id: "m1", postId: "p1", author: "u1" }),
      makeMention({ id: "m2", postId: "p1", author: "u2" }),
      makeMention({ id: "m3", postId: "p1", author: "u3" }),
    ];
    const grouped = groupLoveReasons(mentions);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].competitor).toBe("Typeform");
    expect(grouped[0].reasonCategory).toBe("usability");
    expect(grouped[0].distinctThreads).toBe(1);
    expect(grouped[0].totalMentions).toBe(3);
    expect(grouped[0].isRecurring).toBe(false);
  });

  it("marks reasons as recurring when supported by multiple distinct threads", () => {
    const mentions = [
      makeMention({ id: "m1", postId: "p1" }),
      makeMention({ id: "m2", postId: "p2" }),
    ];
    const grouped = groupLoveReasons(mentions);
    expect(grouped[0].distinctThreads).toBe(2);
    expect(grouped[0].totalMentions).toBe(2);
    expect(grouped[0].isRecurring).toBe(true);
  });
});

describe("grouping dislike reasons", () => {
  const baseDate = new Date("2026-09-01T10:00:00Z");
  function makeMention(
    overrides: Partial<import("@/lib/competitors/read").MentionView>,
  ): import("@/lib/competitors/read").MentionView {
    return {
      id: "m1",
      competitor: "Jotform",
      sentiment: "negative",
      summary: "Too slow",
      quote: "Jotform is painfully slow",
      reasonCategory: "performance",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Complaining about slow form builder speed",
      foundAt: baseDate,
      postId: "p1",
      title: "Jotform issues",
      url: "https://reddit.com/r/SaaS/comments/p1",
      subreddit: "SaaS",
      subredditIconUrl: null,
      author: "user1",
      avatarUrl: null,
      createdAt: baseDate,
      ...overrides,
    };
  }

  it("labels single observations as examples and multiple threads as recurring", () => {
    const mentions = [
      makeMention({ id: "m1", postId: "p1" }),
      makeMention({ id: "m2", postId: "p1" }),
      makeMention({
        id: "m3",
        competitor: "Typeform",
        reasonCategory: "pricing_value",
        postId: "p2",
      }),
      makeMention({
        id: "m4",
        competitor: "Typeform",
        reasonCategory: "pricing_value",
        postId: "p3",
      }),
    ];
    const grouped = groupDislikeReasons(mentions);
    const jotform = grouped.find((g) => g.competitor === "Jotform");
    const typeform = grouped.find((g) => g.competitor === "Typeform");

    expect(jotform?.distinctThreads).toBe(1);
    expect(jotform?.totalMentions).toBe(2);
    expect(jotform?.isRecurring).toBe(false);

    expect(typeform?.distinctThreads).toBe(2);
    expect(typeform?.totalMentions).toBe(2);
    expect(typeform?.isRecurring).toBe(true);
  });
});

describe("listing potential switchers", () => {
  const baseDate = new Date("2026-09-01T10:00:00Z");
  function makeMention(
    overrides: Partial<import("@/lib/competitors/read").MentionView>,
  ): import("@/lib/competitors/read").MentionView {
    return {
      id: "m1",
      competitor: "Typeform",
      sentiment: "negative",
      summary: "Looking for replacement",
      quote: "Need an alternative to Typeform",
      reasonCategory: "pricing_value",
      switchingEvidence: "evaluating_alternatives",
      explanation: "Seeking cheaper alternatives",
      foundAt: baseDate,
      postId: "p1",
      title: "Typeform alternatives?",
      url: "https://reddit.com/r/SaaS/comments/p1",
      subreddit: "SaaS",
      subredditIconUrl: null,
      author: "user1",
      avatarUrl: null,
      createdAt: baseDate,
      ...overrides,
    };
  }

  it("strictly excludes dissatisfied comments that have no switching evidence", () => {
    const mentions = [
      makeMention({
        id: "m1",
        sentiment: "negative",
        switchingEvidence: "dissatisfied_no_switch",
        explanation: "Angry about bug but staying",
      }),
      makeMention({
        id: "m2",
        sentiment: "positive",
        switchingEvidence: "positive_recommendation",
      }),
      makeMention({
        id: "m3",
        sentiment: "neutral",
        switchingEvidence: "no_clear_signal",
      }),
    ];
    const switchers = listPotentialSwitchers(mentions);
    expect(switchers).toHaveLength(0);
  });

  it("deduplicates multiple replies in the same thread into one switcher opportunity", () => {
    const mentions = [
      makeMention({
        id: "m1",
        postId: "p1",
        switchingEvidence: "evaluating_alternatives",
      }),
      makeMention({
        id: "m2",
        postId: "p1",
        switchingEvidence: "actively_switching",
      }),
    ];
    const switchers = listPotentialSwitchers(mentions);
    expect(switchers).toHaveLength(1);
    expect(switchers[0].signal).toBe("actively_switching");
    expect(switchers[0].allMentionsInThread).toHaveLength(2);
  });

  it("prioritizes actively switching over evaluating alternatives", () => {
    const mentions = [
      makeMention({
        id: "m1",
        postId: "p1",
        switchingEvidence: "evaluating_alternatives",
        createdAt: new Date("2026-09-02T10:00:00Z"),
      }),
      makeMention({
        id: "m2",
        postId: "p2",
        switchingEvidence: "actively_switching",
        createdAt: new Date("2026-09-01T10:00:00Z"),
      }),
    ];
    const switchers = listPotentialSwitchers(mentions);
    expect(switchers[0].signal).toBe("actively_switching");
    expect(switchers[1].signal).toBe("evaluating_alternatives");
  });
});

describe("curated benchmark fixture: switching evidence vs general dissatisfaction", () => {
  type BenchmarkItem = {
    id: string;
    text: string;
    groundTruth: {
      sentiment: "positive" | "neutral" | "negative";
      reasonCategory: string;
      switchingEvidence: string;
      isExplicitSwitching: boolean;
    };
  };

  const benchmarkSet: BenchmarkItem[] = [
    {
      id: "b1",
      text: "We are migrating off Typeform this month because of the latest price hike. Already signed up for Tally.",
      groundTruth: {
        sentiment: "negative",
        reasonCategory: "pricing_value",
        switchingEvidence: "actively_switching",
        isExplicitSwitching: true,
      },
    },
    {
      id: "b2",
      text: "Is there any good alternative to Jotform? Their form builder is way too slow and clunky.",
      groundTruth: {
        sentiment: "negative",
        reasonCategory: "usability",
        switchingEvidence: "evaluating_alternatives",
        isExplicitSwitching: true,
      },
    },
    {
      id: "b3",
      text: "Typeform has been really frustrating lately with random webhook failures, but we have too many integrations to ever leave.",
      groundTruth: {
        sentiment: "negative",
        reasonCategory: "reliability",
        switchingEvidence: "dissatisfied_no_switch",
        isExplicitSwitching: false,
      },
    },
    {
      id: "b4",
      text: "I hate how expensive Typeform is, ridiculous pricing tiers for simple forms.",
      groundTruth: {
        sentiment: "negative",
        reasonCategory: "pricing_value",
        switchingEvidence: "dissatisfied_no_switch",
        isExplicitSwitching: false,
      },
    },
    {
      id: "b5",
      text: "We love Typeform, their conversational UX helped our lead conversion rate jump 20%.",
      groundTruth: {
        sentiment: "positive",
        reasonCategory: "recommendation_value_delivered",
        switchingEvidence: "positive_recommendation",
        isExplicitSwitching: false,
      },
    },
    {
      id: "b6",
      text: "Does Typeform support conditional branching logic on the starter plan?",
      groundTruth: {
        sentiment: "neutral",
        reasonCategory: "unknown",
        switchingEvidence: "no_clear_signal",
        isExplicitSwitching: false,
      },
    },
    {
      id: "b7",
      text: "Cancelled our subscription yesterday and moved our whole workflow over to an open-source tool.",
      groundTruth: {
        sentiment: "negative",
        reasonCategory: "other",
        switchingEvidence: "actively_switching",
        isExplicitSwitching: true,
      },
    },
    {
      id: "b8",
      text: "Support at Jotform took 3 weeks to reply to a critical ticket. Horrible experience with customer service.",
      groundTruth: {
        sentiment: "negative",
        reasonCategory: "support",
        switchingEvidence: "dissatisfied_no_switch",
        isExplicitSwitching: false,
      },
    },
    {
      id: "b9",
      text: "Anyone know a tool like Jotform that actually supports two-way HubSpot sync?",
      groundTruth: {
        sentiment: "neutral",
        reasonCategory: "integrations",
        switchingEvidence: "evaluating_alternatives",
        isExplicitSwitching: true,
      },
    },
    {
      id: "b10",
      text: "Just here to drop our Typeform link for the community book club survey.",
      groundTruth: {
        sentiment: "neutral",
        reasonCategory: "unknown",
        switchingEvidence: "no_clear_signal",
        isExplicitSwitching: false,
      },
    },
  ];

  it("verifies fixture definitions ensure negative complaints without switching signals parse as dissatisfied_no_switch", () => {
    const negativeComplaints = benchmarkSet.filter(
      (item) => item.groundTruth.sentiment === "negative" && !item.groundTruth.isExplicitSwitching,
    );
    expect(negativeComplaints.length).toBeGreaterThan(0);

    for (const item of negativeComplaints) {
      const parsedEvidence = switchingEvidenceSchema.parse(item.groundTruth.switchingEvidence);
      expect(parsedEvidence).toBe("dissatisfied_no_switch");
      const isSwitchingSignal =
        parsedEvidence === "actively_switching" || parsedEvidence === "evaluating_alternatives";
      expect(isSwitchingSignal).toBe(false);
    }

    const truePositives = benchmarkSet.filter(
      (item) =>
        item.groundTruth.isExplicitSwitching &&
        (item.groundTruth.switchingEvidence === "actively_switching" ||
          item.groundTruth.switchingEvidence === "evaluating_alternatives"),
    ).length;

    const falsePositives = benchmarkSet.filter(
      (item) =>
        !item.groundTruth.isExplicitSwitching &&
        (item.groundTruth.switchingEvidence === "actively_switching" ||
          item.groundTruth.switchingEvidence === "evaluating_alternatives"),
    ).length;

    const falseNegatives = benchmarkSet.filter(
      (item) =>
        item.groundTruth.isExplicitSwitching &&
        item.groundTruth.switchingEvidence !== "actively_switching" &&
        item.groundTruth.switchingEvidence !== "evaluating_alternatives",
    ).length;

    const precision = truePositives / (truePositives + falsePositives);
    const recall = truePositives / (truePositives + falseNegatives);

    expect(falsePositives).toBe(0);
    expect(precision).toBe(1.0);
    expect(recall).toBe(1.0);
  });
});
