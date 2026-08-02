# Fractals Network — Analysis

*Research date: 2026-07-27. Sources: fractalsnetwork.com homepage, use-case pages (local media companies, entrepreneurs, municipalities), /print, /story, /founder, /updates, /claim.*

Fractals Network is a "local media operating system" built by Matt Moody (4x founder; previously Bellwethr/RetentionEngine — Techstars '18, $3.5M seed, acquired by Stay.ai in 2022). Its pitch: the community newspaper died because its business model collapsed, not because communities stopped needing it — and AI automation of routine coverage makes the economics work again. Fractals sells the platform + playbook; local operators bring "relationships, credibility, and commitment."

## 1. Core value prop and what the operator "owns"

The operator owns **one protected (exclusive) local information market**. Concretely that means:

- **Territorial exclusivity** — each market (roughly, a town/county) can be claimed by exactly one operator; claimed/reserved markets come off the map. At research time: 17 active markets, 1 reserved, ~19,449 available.
- **An owned audience** — first-party email/SMS lists and subscriber relationships, explicitly positioned against algorithm-dependent social distribution.
- **A branded local property** — the site/newsletter is locally branded (the operator's masthead), not Fractals-branded.
- **A revenue stack** — subscriptions, sponsorships, business programs, print, legal notices layered on top of the market license.

Marketing vs. reality note: "own" is marketing language. The operator owns the audience relationships and brand; the *software and market registry* belong to Fractals and are licensed monthly. If the operator stops paying, the "protected market" reverts.

## 2. Feature / component inventory

Labels: **[SW]** = software Curanta could build. **[BM]** = business model / pricing / market strategy, not software. **[SW+BM]** = a software feature whose value is primarily as a revenue product.

### A. Automated coverage / ingestion

| Component | What it appears to actually be | Label |
|---|---|---|
| Public meeting monitoring | Monitors agendas/recordings of government meetings, drafts summaries | [SW] |
| Court coverage / filings | Monitors court records, drafts routine crime/court items | [SW] |
| Public records / FOIA tracking | Tracks public information requests and records releases | [SW] |
| Source monitoring + draft generation | Watches "community sources, public records, meetings, weather, businesses" and drafts recurring briefs | [SW] |
| Weather / routine data briefs | Automated weather and recurring data items | [SW] |
| Event calendar auto-sourcing | Ingests events from "calendars, Facebook, civic sites, schools, chambers" | [SW] |
| Obituaries, sports, announcements publishing | Publishing tools (extent of automation unclear — likely forms + templates) | [SW] |
| Short-form video generation | Converts stories/events/rankings into vertical video ("Shorts Feed" with S3 upload + API, shipped ~June 2026) | [SW] |

### B. Community input

| Component | What it appears to actually be | Label |
|---|---|---|
| Event submissions | Public form → calendar | [SW] |
| Polls (fast-launch) | Operator-created polls capturing "first-party signals"; results publishable | [SW] |
| Approval ratings | Monthly voting on officials/agencies/projects with trend charts; customizable categories; results can be member-gated | [SW+BM] |
| Resident feedback loops / tips | Feedback and submission mechanisms feeding coverage | [SW] |

### C. Local data / analytics

| Component | What it appears to actually be | Label |
|---|---|---|
| Civic dashboards | Market-specific datapoints: gas prices, jail population, rent, health trends, etc., with trend lines | [SW] |
| Rankings / "Best In Town" directories | Ranked business category pages with lead capture + sponsored placement | [SW+BM] |
| Community Impact Scores | Business ranking by "local jobs, sponsorships, civic support, profile completeness" (shipped July 2026) | [SW+BM] |
| Website/crawler analytics for operators | Implied operator-facing analytics | [SW] |

### D. Distribution channels

| Component | What it appears to actually be | Label |
|---|---|---|
| Email briefings (daily/weekly) | Newsletter workflow, unified with SMS, "smart fallback delivery and duplicate-send protection" | [SW] |
| SMS alerts + event reminders | Text distribution and engagement | [SW] |
| Social short-form video + posts | Reels/shorts/stories generation and feeds | [SW] |
| Web (branded site + SEO placement) | The community site itself; local SEO for businesses | [SW] |
| Print (subscriptions, special editions, custom story prints) | Story-to-layout conversion, auto-generated layout, print + ship-to-home fulfillment, subscriber billing. Operator picks stories and approves before printing | [SW+BM] — layout generation is software; the press/fulfillment network is a Fractals-operated service |
| Paid-only story API | API publishing for member-only content | [SW] |

### E. Revenue products

| Component | What it appears to actually be | Label |
|---|---|---|
| Paid digital subscriptions / paywalls | Story paywall, one-step checkout, member gating | [SW] |
| Print subscriptions | Recurring print revenue | [SW+BM] |
| Verified Business Program | $99/yr standard or $499/yr category-exclusive, via Stripe Connect; profiles, announcements, offers | [SW+BM] |
| Category sponsorships | Sponsor inventory around events, analytics, approvals, newsletters, video | [BM] (software = ad-slot management) |
| Boosted/featured events | Paid event placement | [SW+BM] |
| Legal notice publishing | Payments, proofing, affidavits — a regulated revenue line traditional papers held | [SW+BM] |
| Lead generation | In-story lead-capture embeds connecting readers to verified businesses | [SW+BM] |
| "Ribbon Cutting" package | Booking + Stripe payment + photographer scheduling + gallery + distribution — productized local service | [BM] |

### F. Operator / market model (all business model)

- **Exclusive markets** [BM] — one operator per market, permanently while active.
- **Claim + refundable deposit** [BM] — reserve via Stripe deposit; 30-day evaluation window with onboarding, market research, launch checklist, and a sample site/data preview; deposit applies to month one or is fully refunded.
- **Population-based pricing** [BM] — under 5k: $75/mo ($750/yr); 5k–25k: $100–200/mo; 25k–75k: $375–550/mo; 75k–250k: $750–1,125/mo; 250k+: $2.5k+/mo.
- **Operator qualification** [BM] — claimant must live in the community or have a real financial stake (business, real estate).
- **Playbook + onboarding** [BM] — launch checklist, market research, replicable workflows for expanding into adjacent markets.

## 3. Marketing language vs. actual capability

Worth separating, since the site is dense with positioning:

- **Concrete, verifiable capabilities** (the /updates changelog is the best evidence): newsletter email/SMS workflow, story paywall + checkout, approval ratings with trend charts, polls, business directories with lead capture, Stripe Connect business programs, shorts/video feed with S3 upload, print layout integration, paid-story API, signup capture across surfaces, themes. These shipped as dated releases — real software.
- **Vaguer claims**: "automated public meetings monitoring," "court coverage," "public information request tracking" are listed as capabilities but never demoed or changelogged in the pages reviewed. The degree of automation (fully automatic vs. AI-assisted drafting from sources an operator configures) is not documented. Assume "AI drafts from monitored sources, human approves" rather than autonomous coverage.
- **Unverifiable positioning**: "expand coverage without increasing payroll," "durable local network," ROI implications. No case studies, named markets, or revenue proof points appear on the reviewed pages; only 17 active markets exist, so the model itself is early.

## 4. Takeaway for Curanta

The defensible software core Fractals demonstrates is: (1) multi-channel publishing (email/SMS/web/print/video) from one content pipeline, (2) automated *drafting* from monitored civic sources with operator approval, (3) community-input surfaces (polls, ratings, submissions) that double as content and paywall bait, and (4) self-serve local-business revenue tooling. The exclusivity/claim mechanics are pure business model and can be adopted independently of any code.
