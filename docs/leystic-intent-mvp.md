# Leystic: Public Buyer-Intent Discovery (MVP Documentation)

**Product Name**: Leystic  
**Headline**: Find people already asking for what you sell.  
**Supporting Copy**: Leystic finds public conversations where potential customers are asking for tools, exploring alternatives or describing problems your product solves. See the exact post, why it matches, and what to do next.  
**Primary CTA**: Find buying conversations  
**Repository**: Fork of `getanyapi-com/lurk`  

---

## 1. Product Overview & Core Problem

Small B2B software companies typically struggle with customer acquisition because cold outbound (cold email sequences, mass LinkedIn messages) yields declining response rates and burns domain reputation. Meanwhile, hundreds of potential buyers post in public forums every week asking:
* *"What is the best self-hosted tool for X?"*
* *"We are abandoning tool Y due to price hikes. Any good alternatives?"*
* *"How are teams solving problem Z without writing custom scripts?"*

**Leystic solves this problem directly**:
Leystic constantly monitors relevant public discussions (starting with Reddit), filters out noise and self-promoters, evaluates conversations against your product's actual capabilities, provides verifiable verbatim evidence and explainable reasoning, and notifies you so you can provide helpful, authentic human responses.

---

## 2. End-to-End User Workflow

```
[ Product URL ] 
       |
       v
[ Editable Product Profile ]  <-- (User corrects assumptions, exclusions & keywords)
       |
       v
[ Public Buyer Signals ]      <-- (Reddit monitored via AnyAPI; manual or scheduled)
       |
       v
[ Explainable Lead Scoring ]  <-- (Heuristic rejection + LLM evidence extraction)
       |
       v
[ Lead Feed & Alerts ]        <-- (Verbatim quotes, intent category, direct thread link)
       |
       v
[ Human Follow-up ]           <-- (Founder/team writes genuine human reply; NO bots/DMs)
       |
       v
[ Recorded Outcome ]          <-- (User confirms: Replied, Meeting booked, Opportunity, Customer, Not a fit)
```

### Step 1: Product Onboarding via URL
The user enters their company website or product landing page URL.
* Leystic crawls public metadata and key marketing copy.
* It synthesizes an initial draft profile: product description, problem solved, target user personas, core capabilities, and preliminary keywords.
* **Non-negotiable principle**: AI assumptions are never treated as established facts. The user is presented with a comprehensive editable form before any discovery scans run.

### Step 2: Calibrating the Product Profile
The user reviews and edits:
* **Description & Value Proposition**: What the product actually does.
* **Target Users**: Exact titles or team types (e.g., "Full-stack founders", "SecOps engineers").
* **Exclusions & Disqualifiers**: Tools or features you *do not* provide (preventing false matches).
* **Keywords & Phrases**: Core product terms, problem descriptions, and competitor names.
* **Target Communities**: Subreddits where ideal customers hang out (e.g. `r/selfhosted`, `r/devops`, `r/SaaS`).

### Step 3: Public Signal Ingestion
* **Primary Source (MVP)**: Reddit public conversations.
* **Provider Integration**: AnyAPI search endpoint (`/reddit/search`) querying designated keywords and subreddits.
* **Cadence**: Permitted manual scan (instant trigger) or scheduled periodic scans (daily / multi-hourly).
* **Controlled Scope**: Additional platforms (like X/Twitter) are disabled by default (`X_LEADS=false`) to ensure predictable costs and high signal density.

### Step 4: Explainable Lead Scoring & Rejection Gates
Scoring is split into two deterministic stages to minimize LLM token spend:
1. **Heuristic Pre-Filtering**:
   * Drops deleted posts, bot automoderator comments, and zero-content threads.
   * Eliminates self-promotional posts (e.g., authors sharing their own GitHub repository or product launch).
   * Filters out already-resolved queries or non-purchasing discussions.
2. **LLM Evaluation & Evidence Extraction**:
   * Evaluates intent against the calibrated product profile:
     - *Looking for tool / recommendation*
     - *Alternative to named competitor*
     - *Active unresolved problem*
   * Extracts exact verbatim quotes from the thread.
   * Generates a concise, plain-English rationale explaining why this discussion represents a commercial opportunity.

### Step 5: Actionable Lead Feed
Every lead card in the application displays:
* **Thread Title & Link**: Direct, 1-click external link to the live public thread.
* **Verbatim Evidence**: Highlighted excerpt from the author showing their active need.
* **Intent & Match Rationale**: Clear reasoning of why the post qualifies.
* **Author & Community**: Pseudonym handle, community name, and publication timestamp.
* **Processing Cost**: Transparent display of API and model costs required to index and score the lead.

### Step 6: Alerts & Scheduled Notifications
Teams do not need to sit in the dashboard all day:
* **Multi-Channel Dispatchers**: Slack webhook, Discord webhook, Telegram bot, or email digest (via Resend).
* **Custom Thresholds**: Configure alerts for high-confidence leads only (score >= 70) to prevent notification fatigue.

### Step 7: Human-in-the-Loop Follow-up
* **Absolute Safety Rule**: Leystic never auto-posts comments, never auto-generates automated Reddit DMs, and never impersonates a human.
* The user clicks the link, opens Reddit in their browser, and writes a genuine, transparent, value-first response as themselves.

### Step 8: Closed-Loop Outcome Tracking (Differentiator)
Directly on the lead card or detail view, the user records what happened:
* `Replied`: A response was posted to the thread.
* `Meeting booked`: The poster agreed to connect or scheduled a demo.
* `Opportunity`: Active ongoing sales conversation or trial evaluation.
* `Customer`: The lead converted into a paying customer.
* `Not a fit`: The lead turned out to be irrelevant (with optional feedback note).
* *Purpose*: This first-party feedback loop enables Leystic to learn which subreddits and keyword patterns generate real revenue.

---

## 3. Architecture & Technical Stack

* **Framework**: Next.js 14 with App Router (`src/app`).
* **Language**: TypeScript (strict mode, 100% typed).
* **Database & ORM**: PostgreSQL with Drizzle ORM (`src/db/schema/`).
  * Tenant isolation via multi-tenant schemas (`tenantId`, `projectId`).
  * Additive schema migration: `drizzle/0040_lead_outcomes.sql`.
* **Authentication**: Clerk (`@clerk/nextjs`).
* **UI & Styling**: Tailwind CSS, Radix UI primitives, Lucide icons, Leystic design tokens (`--brand: #577bf4`).
* **Data Sources**: AnyAPI Reddit API (`src/lib/sources/`).
* **Model Inference**: Vercel AI SDK (`ai`) interfacing Anthropic Claude, OpenAI, or Gemini.

---

## 4. Cost Visibility & Financial Protection

Leystic treats data costs with complete transparency:
1. **AnyAPI Request Costs**: Tracked per query in micro-cents and stored in the database.
2. **Model Token Costs**: Stored in a distinct model ledger (prompt tokens, completion tokens, model name).
3. **Daily Spending Caps**: Hard spend ceilings per tenant prevent accidental runaway scheduled jobs.
4. **Distinction**: Third-party API charges and LLM inference charges are accounted for separately.

---

## 5. Main Navigation Structure

The customer-facing application is focused around six core views:
1. **Leads** (`/app/leads`): The primary triage feed of active opportunities, filters, and outcome buttons.
2. **Product** (`/app/product`): The editable product profile, keywords, exclusions, and target audience.
3. **Competitors** (`/app/competitors`): Monitored competitor mentions, alternative requests, and sentiment.
4. **Insights** (`/app/insights`): Aggregated analysis of top communities, high-performing keywords, and signals.
5. **Usage** (`/app/usage`): Real-time breakdown of API query costs, model token usage, and daily limits.
6. **Settings** (`/app/settings`): Alert channels (Slack, Telegram, Discord, Email), team members, and preferences.

*Note*: Secondary settings and sub-views (`/app/filters`, `/app/sources`, `/app/settings/alerts`) remain fully functional via their respective contextual links.

---

## 6. Local Setup & Verification

### Prerequisites
* Node.js v20+ (tested on Node v26)
* PostgreSQL 15+ (local or hosted, e.g. Neon, Supabase)

### Setup Commands
```bash
# Clone the repository
git clone https://github.com/AyushCodesu/leystic-intent.git
cd leystic-intent

# Install dependencies
npm install

# Run database migrations
npm run db:migrate

# Start local development server
npm run dev
```

### Verification Commands
```bash
# Verify static types
npm run typecheck

# Run test suite
npm run test

# Build production bundle
npm run build
```

---

## 7. Legal, Copyright & Attribution

* **License**: MIT License (retained in `LICENSE`).
* **Upstream Attribution**: Leystic is derived from the open-source Lurk project by AnyAPI. Copyright notices and upstream MIT terms are fully preserved in accordance with open-source obligations.
* **Independence**: Leystic is an independent product and is not operated by, endorsed by, or affiliated with AnyAPI.
