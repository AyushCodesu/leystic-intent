# Leystic: Future Product Opportunities & Strategic Evaluation

**Date**: October 2026  
**Document Version**: 1.0  
**Status**: Strategy & Horizon Evaluation  
**Product**: Leystic (Public Buyer-Intent Discovery for Small B2B Software Companies)  

---

## 1. Executive Summary

Leystic's core mission is to help small B2B software companies find people already asking for a product, alternative, or solution they can provide. Rather than acting as an autonomous spam bot or generic email scraping database, Leystic focuses on **high-intent public conversations, verifiable evidence, transparent scoring, and human-in-the-loop follow-up**.

This document benchmarks observed market solutions against Leystic's positioning, evaluates 8 strategic differentiators, ranks them by customer value versus implementation complexity and risk, and concludes with 3 actionable post-MVP experiments.

---

## 2. Competitive Landscape & Observed Capabilities

To establish clear market boundaries, we separate verified observed capabilities of existing tools from Leystic's strategic ideas.

### 2.1 Lurk (`getanyapi-com/lurk`)
* **Observed Capabilities**:
  * Open-source self-hostable buyer-intent finder for Reddit and X.
  * Direct AnyAPI integration for platform querying with transparent per-request and model token accounting.
  * Explainable heuristic + LLM scoring with clear rationale and verbatim matched quotes.
  * Multi-channel alerting (Telegram, Slack, Discord, Email via Resend).
* **Observed Gaps / Limitations**:
  * Purely top-of-funnel discovery; has no feedback loop on whether a lead led to a real reply, call, or customer.
  * Limited guidance on subreddit etiquette or whether community rules forbid vendor participation.
  * No competitor-switching intent specialization.
* **Leystic Angle**:
  * Build on Lurk's robust, explainable foundation while introducing a closed-loop outcome tracker and brand-first, human-centric guidance.

### 2.2 Clean (`tryclean.ai`)
* **Observed Capabilities**:
  * Ingests full company context (website, docs, case studies) to construct an ICP profile.
  * Detects real-world trigger events (permits, commercial shipping manifests, corporate registrations, relocations).
  * Surfacing "warm relationship paths" via team LinkedIn networks and previous customer champions.
  * Contextual outbound generation calibrated against buyer ICP.
* **Observed Gaps / Limitations**:
  * Tailored heavily toward mid-market enterprise sales with long sales cycles and existing CRM graphs.
  * Trigger events (filings, permits) often correlate poorly with small B2B SaaS adoption.
* **Leystic Angle**:
  * Focus on immediate, vocal problem expressions in public forums rather than passive corporate filings. Real people asking "What tool does X?" have 10x higher immediacy for early-stage B2B software.

### 2.3 Workflows.io
* **Observed Capabilities**:
  * High-touch GTM playbooks combining AI tooling (Clay, Instantly, HeyReach) with agency RevOps services.
  * Data enrichment cascades, intent orchestration, and cold email deliverability management.
* **Observed Gaps / Limitations**:
  * High complexity and high ongoing service retainer costs.
  * Focuses heavily on outbound push (cold email sequences) rather than inbound intent capture.
* **Leystic Angle**:
  * Small B2B software teams cannot afford $5k-$15k/mo agency retainers. Leystic delivers immediate self-serve intent capture with zero deliverability/reputation risk.

### 2.4 Glasa (`glasa.io`) & Explee (`explee.com`)
* **Observed Capabilities**:
  * Vast contact databases (800M+ profiles) with email/phone enrichment and triple-verification cascades.
  * Natural language ICP search and automated AI SDR sequences across email and LinkedIn.
  * Autonomous outreach scheduling meetings directly on calendars.
* **Observed Gaps / Limitations**:
  * Aggressive outbound execution creates brand fatigue and regulatory/spam compliance overhead.
  * People listed in databases are not actively asking for software; response rates are low (<1-3%).
* **Leystic Angle**:
  * Invert the model: Instead of cold-messaging 1,000 passive contacts, surface the 5 people who explicitly asked for your solution today.

---

## 3. Evaluation of 8 Potential Differentiators

Each opportunity is evaluated across: Customer Problem, Existing Solutions, What Leystic Could Do Better, Technical Difficulty, Ongoing Data/Model Cost, Privacy & Platform Risks, and Required Customer Evidence.

```
+------------------------------------------------------------------------------------------------------+
| 1. Real Outcome Loop (Public Signals -> Meetings -> Opportunities)                                  |
+------------------------------------------------------------------------------------------------------+
* Customer Problem: Users spend time monitoring feeds but don't know which subreddits, keywords, or
  intents actually result in closed deals.
* Existing Solutions: Disconnected CRMs (HubSpot, Pipedrive) require manual logging; intent tools stop
  at the alert.
* What Leystic Could Do Better: Minimal, zero-friction 1-click outcome tagging (Replied -> Meeting ->
  Opportunity -> Customer -> Not a fit) right in the lead card. Correlate win-rates back to subreddits
  and keywords.
* Technical Difficulty: Low. Additive schema columns and simple outcome actions (already prototyped in
  MVP).
* Ongoing Cost: Negligible ($0 data/model cost).
* Privacy/Platform Risks: None. Purely first-party tenant data.
* Required Evidence: >=25% of active users recording outcomes on surfaced leads.
```

```
+------------------------------------------------------------------------------------------------------+
| 2. Competitor-Switching Intent & Alternatives Detection                                              |
+------------------------------------------------------------------------------------------------------+
* Customer Problem: The highest-converting leads are users actively venting about or seeking replacements
  for an incumbent competitor ("X pricing just doubled", "Looking for an alternative to Y").
* Existing Solutions: Generic keyword alerts match every passing mention, flooding feeds with noise.
* What Leystic Could Do Better: Dedicated intent classifiers distinguishing between recommendation,
  complaint, churn signal, and feature comparison.
* Technical Difficulty: Medium. Refine LLM prompt extraction and heuristic scoring to categorize
  competitor context specifically.
* Ongoing Cost: Minor (included in standard single-pass LLM scoring prompt).
* Privacy/Platform Risks: None (public data).
* Required Evidence: Customers explicitly asking to track competitor names and filtering by
  "Alternative Sought".
```

```
+------------------------------------------------------------------------------------------------------+
| 3. Community-Rule-Aware Guidance                                                                     |
+------------------------------------------------------------------------------------------------------+
* Customer Problem: Founders jumping into subreddits to pitch their product get banned or downvoted for
  violating "No self-promotion" or "Weekly promo thread only" rules.
* Existing Solutions: None. Founders must manually read sidebar wikis for every subreddit.
* What Leystic Could Do Better: Fetch and parse subreddit rules once per community; show a badge:
  "Promotions allowed with disclosure", "No commercial links", or "Self-promo thread only".
* Technical Difficulty: Low to Medium. Parse Reddit subreddit `/about.json` rules endpoint during scan.
* Ongoing Cost: Low (infrequent cacheable API fetches).
* Privacy/Platform Risks: Must respect Reddit API rate limits.
* Required Evidence: Users reporting hesitation or bans when responding to public threads.
```

```
+------------------------------------------------------------------------------------------------------+
| 4. Human-Reviewed, Context-Specific Reply Assistance                                                 |
+------------------------------------------------------------------------------------------------------+
* Customer Problem: Founders struggle to draft authentic, non-salesy replies that add value to the
  thread while introducing their tool.
* Existing Solutions: Generic ChatGPT prompts generating robotic, obvious AI pitches that get mocked.
* What Leystic Could Do Better: "Helpful peer" draft generator that extracts the exact technical question,
  outlines the direct answer first, and suggests a transparent, humble plug at the end.
* Technical Difficulty: Medium. Prompt engineering with strict anti-slop guidelines and strict human
  copy-paste workflow (never auto-post).
* Ongoing Cost: Low (~$0.001 - $0.003 per generated draft using fast reasoning models).
* Privacy/Platform Risks: Must maintain human-in-the-loop guarantee; never integrate automated posting.
* Required Evidence: Users requesting assistance on "What should I say to this thread?"
```

```
+------------------------------------------------------------------------------------------------------+
| 5. Broader Source Coverage (Hacker News, LinkedIn, Bluesky, Mastodon)                                |
+------------------------------------------------------------------------------------------------------+
* Customer Problem: Niche B2B software buyers also discuss problems on HN (Ask HN), Bluesky, or niche
  forums.
* Existing Solutions: Multi-source social listening tools (Brand24, Mention) with high price tags and
  low intent precision.
* What Leystic Could Do Better: Curate developer/tech-focused platforms (e.g. Hacker News Firebase API,
  GitHub Discussions) with the same strict intent filter.
* Technical Difficulty: Medium to High depending on the platform's API stability and auth barriers.
* Ongoing Cost: Medium. Additional indexing, rate limiting, and deduplication.
* Privacy/Platform Risks: Strict adherence to terms of service; avoid unofficial scraping hacks.
* Required Evidence: High proportion of customer ICPs that do not frequent Reddit.
```

```
+------------------------------------------------------------------------------------------------------+
| 6. Warm Relationship Paths via First-Party Graph                                                     |
+------------------------------------------------------------------------------------------------------+
* Customer Problem: Cold contact has low conversion; an introduction through a mutual contact converts
  at 5x-10x.
* Existing Solutions: Clean, Common Room, Crossbeam, Warmly.
* What Leystic Could Do Better: Connect discovered public leads to team LinkedIn/Gmail connections if an
  identity match exists.
* Technical Difficulty: High. OAuth integrations, graph matching, and complex data synchronization.
* Ongoing Cost: High (OAuth token maintenance, sync infrastructure).
* Privacy/Platform Risks: High (GDPR, personal network data access, user trust).
* Required Evidence: B2B customers with enterprise ACVs ($20k+) willing to connect email/social accounts.
```

```
+------------------------------------------------------------------------------------------------------+
| 7. Contact Enrichment (Third-Party Providers)                                                        |
+------------------------------------------------------------------------------------------------------+
* Customer Problem: A Reddit user is anonymous; founders want to know what company they work for and
  reach out via professional channels.
* Existing Solutions: Clearbit, Apollo, People Data Labs, FullContact.
* What Leystic Could Do Better: Match public profiles or personal domains mentioned in bios to verified
  B2B personas.
* Technical Difficulty: High. De-anonymizing pseudonymous forum handles is unreliable and legally murky.
* Ongoing Cost: High ($0.05 - $0.30 per enrichment lookup).
* Privacy/Platform Risks: Severe. Violates user expectations of forum anonymity and risks privacy
  backlash.
* Required Evidence: Explicit customer demand for deanonymization despite high costs and low hit rates.
```

```
+------------------------------------------------------------------------------------------------------+
| 8. Concierge Setup & Search Optimization Service                                                     |
+------------------------------------------------------------------------------------------------------+
* Customer Problem: Busy early-stage founders sign up, enter a poor URL or sparse keywords, see 0 leads,
  and churn within 48 hours.
* Existing Solutions: Standard SaaS onboarding tours or expensive $3,000/mo agency onboarding.
* What Leystic Could Do Better: High-touch "Done-For-You Profile Calibration": a human product specialist
  tunes keywords, subreddits, exclusions, and test scans within 24 hours of signup.
* Technical Difficulty: Low. Operational service offering, no new code required.
* Ongoing Cost: Human operational time (30 mins per customer).
* Privacy/Platform Risks: None.
* Required Evidence: High drop-off at onboarding or requests for configuration help.
```

---

## 4. Prioritization Matrix

We score each differentiator on a 1-5 scale across four key criteria:
* **Customer Value (CV)**: Impact on discovering and closing actual buyers.
* **Evidence Available (EA)**: Market demand signals and user feedback.
* **Low Implementation Effort (LE)**: Simplicity to build and maintain (5 = very easy, 1 = very hard).
* **Low Risk & Cost (LR)**: Minimal financial, legal, and platform exposure (5 = very safe, 1 = high risk).

| Differentiator | CV (1-5) | EA (1-5) | LE (1-5) | LR (1-5) | Composite Score (/20) | Priority |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **1. Real Outcome Loop** | 5 | 4 | 5 | 5 | **19** | **P1 (Immediate)** |
| **2. Competitor-Switching Intent** | 5 | 5 | 4 | 5 | **19** | **P1 (Immediate)** |
| **3. Community-Rule Guidance** | 4 | 4 | 4 | 4 | **16** | **P2 (Near-Term)** |
| **4. Human-Reviewed Reply Assist** | 4 | 3 | 3 | 4 | **14** | **P2 (Near-Term)** |
| **8. Concierge Setup Service** | 4 | 4 | 4 | 4 | **16** | **P2 (Commercial)** |
| **5. Broader Sources (HN/GH)** | 3 | 3 | 3 | 3 | **12** | **P3 (Exploratory)** |
| **6. Warm Relationship Paths** | 3 | 2 | 1 | 2 | **8** | **P4 (De-prioritized)** |
| **7. Contact Enrichment** | 2 | 2 | 2 | 1 | **7** | **P4 (Rejected/High Risk)** |

---

## 5. Recommended Top 3 Candidate Experiments Post-MVP

Based on our scoring, Leystic should focus strictly on the top 3 high-impact, low-risk initiatives:

### Experiment 1: Closed-Loop Outcome Analytics (The ROI Proof)
* **Hypothesis**: Giving users simple 1-click outcome tagging (`Replied`, `Meeting booked`, `Opportunity`, `Customer`, `Not a fit`) will prove Leystic's tangible ROI within 14 days and allow us to feed winning signals back into ranking.
* **Test Plan**:
  1. Monitor outcome adoption in the Lead Feed.
  2. For users with >=3 recorded positive outcomes, generate a mini "Wins" summary showing which subreddit and keywords produced the wins.
* **Success Metric**: >=30% of weekly active teams tag at least one lead outcome per week.

### Experiment 2: Competitor Churn & Alternative Hunter
* **Hypothesis**: Identifying explicit frustration with named competitors yields 3x higher reply conversion rates than general problem discussions.
* **Test Plan**:
  1. Add a dedicated "Competitor Dissatisfaction & Alternatives" filter toggle in the feed.
  2. Refine LLM prompt extraction to identify: (a) incumbent tool used, (b) specific limitation cited, and (c) request for alternatives.
* **Success Metric**: Leads tagged with `alternative_sought` receive a 50% higher "Replied" rate from users.

### Experiment 3: Subreddit Etiquette & Safety Badges
* **Hypothesis**: Founders fail to respond because they fear community moderation backlash. Providing clear etiquette rules directly above the reply link will increase founder engagement.
* **Test Plan**:
  1. Parse the rules for the top 50 B2B tech subreddits.
  2. Surface a gentle badge on each card: e.g. "Direct links discouraged - provide value first" or "Vendor participation welcome with disclosure".
* **Success Metric**: 25% increase in click-through to original public threads.
