import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { XOpportunityList } from "@/components/x/XOpportunityList";
import type { XHeldCard, XOpportunity } from "@/lib/x/read";
import { XOpportunityBadge } from "@/components/x/XOpportunityBadge";

function opportunity(id: string, priority: number | null): XOpportunity {
  const card: XHeldCard = {
    entryId: `held-${id}`, evaluationId: id, tweetId: id, headline: `Request ${id}`, text: `Request ${id}`, url: `https://x.com/test/status/${id}`,
    authorUsername: `author${id}`, authorName: null, authorImage: null, authorFollowers: null, authorVerified: null, authorLocation: null,
    authorBio: null, authorCreatedAt: null, postedAt: new Date("2026-10-09"), fetchedAt: new Date("2026-10-09"),
    likeCount: null, replyCount: null, viewCount: null, isReply: false, replyingTo: [], foundBy: null, via: null,
    reason: null, reasonCode: null, fit: 3, intent: 3, engagement: 3,
  };
  return { entry: { kind: "held", item: card }, priority, checks: ["Check requirements"] };
}

it("renders uncertain opportunities in one stream, selects them, and keeps weaker/unscored cards accessible", () => {
  const html = renderToStaticMarkup(createElement(XOpportunityList, {
    items: [opportunity("strong", 0.55), opportunity("weak", 0.2), opportunity("unknown", null)],
    params: {}, selectedId: "held-strong",
  }));
  expect(html).toContain('aria-current="true"');
  expect(html).toContain(">Potential match<");
  expect(html).not.toMatch(/priority \d+/u);
  expect(html).toContain("Check requirements");
  expect(html.match(/Weaker matches below/gu)).toHaveLength(1);
  expect(html.indexOf("Request strong")).toBeLessThan(html.indexOf("Weaker matches below"));
  expect(html.indexOf("Weaker matches below")).toBeLessThan(html.indexOf("Request weak"));
  expect(html).toContain("Request unknown");
  expect(html).toContain(">Weaker match<");
  expect(html).toContain(">Unassessed<");
  expect(html).not.toContain(">Maybe<");
  expect(html).not.toContain(">Left out<");
});

it("uses ranked evidence rather than old lead verdicts in New, but preserves verdicts in history", () => {
  const held = opportunity("qualified", 0.2);
  if (held.entry.kind !== "held") throw new Error("Expected held fixture");
  const qualified: XOpportunity = {
    ...held,
    entry: { kind: "lead", lead: {
      ...held.entry.item, id: "qualified", kind: "ask", moment: null, reach: 0, fresh: true,
      foundAt: new Date("2026-10-09"), score: 90, quote: null, status: "new", fit: 4, intent: 4, conversationId: "qualified",
    } },
    checks: [],
  };
  const ranked = renderToStaticMarkup(createElement(XOpportunityBadge, { opportunity: qualified }));
  expect(ranked).toContain(">Weaker match<");
  expect(ranked).not.toContain("Strong lead");
  const history = renderToStaticMarkup(createElement(XOpportunityBadge, { opportunity: { ...qualified, priority: null }, ranked: false }));
  expect(history).toContain("Strong lead");
  expect(history).not.toContain("Unassessed");
  const strong = renderToStaticMarkup(createElement(XOpportunityBadge, { opportunity: { ...qualified, priority: 0.8 } }));
  expect(strong).toContain(">Potential match<");
  expect(strong).not.toContain("Strong lead");
  const heldBadge = renderToStaticMarkup(createElement(XOpportunityBadge, { opportunity: opportunity("held", 0.8) }));
  expect(heldBadge).toContain(">Potential match<");
  expect(heldBadge).toContain("Check requirements");
});
