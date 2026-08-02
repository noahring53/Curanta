# Fractals × Curanta — Gap Analysis

*Date: 2026-07-27. Rows are Fractals SOFTWARE capabilities (from [fractals-analysis.md](fractals-analysis.md) §2, [SW] and [SW+BM] items). Status is Curanta today (from [curanta-audit.md](curanta-audit.md)). Effort assumes the existing stack (Express + vanilla JS + Supabase + Anthropic); S ≈ days, M ≈ 1–2 weeks, L ≈ multi-week.*

## Capability matrix

| Fractals capability | Curanta status | Effort | Value to a local publisher |
|---|---|---|---|
| **Automated coverage / ingestion** | | | |
| Source monitoring + AI draft generation | **Partial** — best-in-class drafting pipeline exists, but ingestion is browser-triggered with no persistence, dedupe, or schedule | M | Core promise: coverage without payroll — this is the product |
| Public meeting monitoring + summaries | **Missing** — no meeting concept, no transcripts (YouTube handled as RSS metadata only) | L | Highest — the #1 thing residents can't get elsewhere and the flagship differentiator |
| Court / crime coverage from filings | **Missing** — no structured-records ingestion; also needs a mandatory review gate (names private individuals) | L | High, but legally sensitive; defer behind meeting coverage |
| Public records / FOIA tracking | **Missing** | M | Niche; low urgency |
| Weather / recurring data briefs | **Missing** — but config-driven sections + a data source would get there cheaply | S | Medium — cheap daily-habit content |
| Event calendar auto-sourcing | **Missing** — no calendar entity or event ingestion | M | High — events are the top reader utility and a sponsor surface |
| Short-form video generation | **Missing** | L | Medium — distribution reach, but far from Curanta's newsletter core |
| **Community input** | | | |
| Event/tip/interview submission forms | **Missing** — no public-facing surfaces at all (app is operator-only) | M | High — free content supply + community buy-in |
| Polls | **Missing** | M | Medium — engagement + publishable content |
| Approval ratings with trends | **Missing** — needs public voting surface + time-series storage | M–L | Medium — differentiating and paywall-worthy, but needs audience volume first |
| **Local data / analytics** | | | |
| Civic dashboards (gas, jail, rent… with trend lines) | **Missing** — no time-series data layer | L | Medium-high — sponsorable, sticky, but each datapoint is its own scraper |
| Ranked business directories | **Missing** | M | Medium — mostly a revenue surface |
| **Distribution** | | | |
| Email newsletter production | **Have** — this is Curanta's core, and its writing-quality pipeline likely exceeds Fractals' | — | — |
| Email *sending* / list management | **Partial** — publishes drafts to Beehiiv (deployment-global credentials); no owned list, no per-tenant ESP | M | High — owned audience is the whole thesis; per-tenant Beehiiv creds are the cheap first step |
| SMS alerts | **Missing** | M | Medium — strong for alerts/reminders; add after email is per-tenant |
| Branded public website | **Missing** — no reader-facing site; newsletters are the only output | L | High for the full Fractals model; not needed while operators use Beehiiv's hosted pages |
| Story paywall / subscriptions (reader-side) | **Missing** (Stripe exists but bills *operators*, not readers) | M–L | High later — requires the public site first |
| Print layout generation | **Missing** | L | Low now — real revenue for Fractals but heavy (layout + fulfillment); revisit much later |
| Paid-only story API | **Missing** | S–M | Low now |
| **Revenue products (software side)** | | | |
| Verified business profiles / self-serve business programs | **Missing** — Stripe Connect needed | M–L | High revenue-per-effort *once* there's a public surface |
| Sponsor slots in newsletter | **Partial** — a CTA/Sponsor section exists as content; no inventory/booking management | S–M | High — nearest-term operator revenue |
| Boosted events / featured placement | **Missing** (needs events first) | S after events | Medium |
| Legal notice publishing | **Missing** | M | Niche but real recurring revenue in many states |
| Lead-gen embeds | **Missing** | M | Low-medium |
| **Platform / licensing prerequisites (implied by "operating system")** | | | |
| Market-scoped multi-tenancy | **Partial** — multi-user SaaS with per-user publications; no market entity, no geography, no teams | M | Prerequisite for licensing Curanta at all |
| White-label branding (name/logo/domain per tenant) | **Missing** — Curanta branding is fixed | M | Prerequisite for licensing |
| Background jobs / scheduled automation | **Missing** — zero non-request-driven code | M (foundation) | Prerequisite for every "automated" row above |
| Operator review queue (persisted, deduped triage) | **Partial** — AI fit-scoring + drag-to-compose exist, but nothing is persisted server-side; no dedupe; queue dies with the browser tab | M | Prerequisite — the spine all pipelines feed into |

## Highest leverage-to-effort gaps

Ranked by (value to a local publisher) ÷ (build effort), honoring dependency order:

1. **Jobs + persisted, deduped review queue (M).** Not a Fractals "feature" but the enabler of every automated-coverage row. Curanta already has ingestion and scoring; persisting articles server-side, deduping, and running fetches on a schedule converts the existing builder into the "one triaged queue" model. Everything below lands in it.
2. **Automated public-meeting coverage (L, but unmatched value).** The flagship gap. YouTube RSS triggers + agenda RSS + transcript → per-item highlights with votes and timestamps is exactly the "coverage no one else has" that justifies an operator's subscription price. Curanta's synthesis/grounding pipeline is 70% of the hard part already built.
3. **Ambient monitoring breadth (M).** RSS is done; adding change-detection and social bridges plus a daily AI ranking pass is incremental on the queue — big perceived "the platform watches the whole town" payoff for modest work.
4. **Community intake forms (M).** First public-facing surface, cheap, feeds the queue, and creates the community moat Fractals sells. Events unlock boosted-event revenue later.
5. **Market-scoped tenancy + white-label (M).** Publications → markets, per-tenant Beehiiv credentials, brandable UI. Pure prerequisite for the licensing goal; no reader-visible payoff, so schedule it alongside (not before) a flashy pipeline.
6. **Newsletter sponsor inventory (S–M).** Small software lift on an existing section type; directly monetizes the operator's issue.

Deliberately deferred despite being core to Fractals: public reader site + paywall (L, changes Curanta's product shape), civic dashboards (per-datapoint scraper grind), court coverage (legal sensitivity — build the review gate first), video and print (far from core, heavy).
