# Phase 6 — The creator dashboard

**Date:** 2026-09-11
**Programme:** `2026-09-09-udara-program-design.md`
**Follows:** Phase 5, `2026-09-11-community-checkout-design.md` (merged)
**Branch:** `feat/udara-dashboard`

## Goal

A community owner can see how their community is doing: what it has earned,
how that has moved over six months, which tiers people are on, and who has
joined lately.

## No schema change

**Every number below computes from tables that already exist** —
`user_transaction`, `user_subscription` and `community_member` — and it only
computes because Phase 5 put `community_id` on the subscription. Without that
column, attributing revenue to a community would mean joining transaction →
subscription → tier → community on every aggregate.

That column was added for a unique index, not for this. It is worth recording
that it paid for itself twice, because the next person tempted to remove a
"redundant" denormalised column should know what reads it.

## Where it lives

**A tab on the community page**, `?tab=statistik`, owner-only — beside
Diskusi, Kegiatan, Dokumen, Keanggotaan and Anggota.

The reference's data is `creatorStatsByCommunity`: one dashboard per
community, not one per person. A separate `/dasbor` section would be a second
shell, a second navigation and a second set of layout decisions, for a screen
the reference does not show as separate. The retire-telegram phase deleted the
old `/dashboard/*` app; this does not resurrect it.

**The tab is not rendered for anyone but the owner.** Not disabled, not
showing an empty state — absent. The rule Phase 1 set when it cut the tab bar
rather than render tabs with nothing behind them.

## The API

| Method | Path | Auth |
|---|---|---|
| `GET` | `/communities/:slug/stats` | **owner** |

**One endpoint, all four panels.** It is one screen, and four endpoints would
be four round trips and four chances to render half a dashboard — one panel
loaded, one spinning, one failed. The panels are also not independently
useful: "revenue" without "over what period" is a number nobody can act on.

**Owner-only, and a non-owner gets 403 rather than 404.** This is the one
place in the phase where the usual rule reverses. Elsewhere a refusal is a 404
so it cannot confirm what exists — but the community's existence is already
public (its page, its feed, its calendar are all open), so there is nothing
left to conceal, and a 403 tells an owner who is signed into the wrong account
what is actually wrong.

## The metrics, defined precisely

A ratio that is subtly wrong is worse than one that is absent, so each is
defined here and each definition is asserted in a test.

### Revenue

```
totalRevenue = SUM(user_transaction.amount)
  WHERE status = 'paid'
    AND its subscription's community_id = this community
```

Integer rupiah, matching every other money value in this codebase. No
currency formatting on the wire — `formatRupiah` on the client owns that.

### Members

```
memberCount           = COUNT(community_member)
newMembersThisMonth   = COUNT(community_member WHERE joined_at IN the current WIB month)
```

**A WIB month, reusing Phase 3's `wibMonthRange`.** September in Jakarta
begins seven hours before September in UTC, so a UTC reading drops every
member who joined between midnight and 07:00 on the 1st out of the month that
owns them — and an owner checking on the 1st would see their morning's
signups missing.

### Payment success rate

```
paymentSuccessRate = paid / (paid + expired)     -- TERMINAL transactions only
```

**Pending transactions are excluded from both sides.** An invoice still in
flight is neither a success nor a failure; counting it as either misstates the
number, and counting it as a failure makes a healthy community with a busy
checkout look broken.

### Churn rate

```
churnRate = (cancelled + expired subscriptions) / (every subscription that was ever active)
```

**This is LIFETIME churn, not monthly**, and the difference matters enough to
label it on screen. The reference shows "3,2%" with no definition attached;
rather than guess at a monthly rate this data cannot support (nothing records
when a subscription's status changed, only its current value), this picks the
definition the data does support and says which one it is.

### Both ratios are `null` when the denominator is zero

**Never `0`.** A brand-new community has no success rate and no churn rate —
it has no transactions and no subscriptions. Reporting `0%` would tell its
owner that every payment is failing and nobody is leaving, one of which is a
lie and the other is meaningless. `null` renders as "—" and says nothing.

### Revenue by month

```
revenueByMonth = the last 6 WIB months, each { month: "YYYY-MM", amount: integer }
```

**Zero-filled.** A month with no revenue is `0`, present in the series. A
month simply missing from a chart reads as absent data — a gap the eye
interprets as "unknown", not as "nothing happened". This is the difference
between a chart that says business was quiet in June and one that says June is
broken.

Six months because that is what the reference shows, and because a bar chart
of six labelled months fits a phone without rotating the labels.

### Tier distribution

```
tierDistribution = per tier of this community: { tierId, name, subscriberCount }
```

COUNTS, not percentages. The client renders proportions; sending percentages
would mean the server rounding, and rounded percentages that must sum to 100
are their own small nightmare. A tier with no subscribers is included — an
owner needs to see the tier nobody is buying.

### Recent members

```
recentMembers = the 5 newest community_member rows:
  { handle, displayName, joinedAt, standing }
```

`standing` is `member` | `lapsed` | `none`, from the same `membershipStanding`
function `IsMemberOf` uses — so "active" means exactly one thing across the
app. `none` is the common case: joining is free, so most members hold no
subscription at all.

## The chart

The revenue series is the first chart in this codebase. **Load the `dataviz`
skill before writing it** rather than improvising — there is no existing chart
to copy conventions from, so whatever this establishes becomes the
convention.

It must work at 360px, in both themes, and it must not add a charting
dependency: six bars is inline SVG or CSS, and pulling in a library to draw
them would be the kind of addition this repo does not make.

## Not in this phase

- **`topDocuments`.** Phase 4a deferred download counting to "the phase that
  has a surface to read it" — that is this phase, and it is still deferred,
  because counting means a WRITE on the download path. A read that writes
  needs its own thinking about failure (a counter that throws must not fail
  the download) and its own decision about whether a re-download counts. That
  is a small phase, not a panel.
- **`activityLog`.** The reference's rows are joins, upgrades, failed
  recurring payments, churn and content purchases. Upgrades do not exist —
  Phase 5 shipped cancel-and-resubscribe. Content purchases do not exist at
  all. Building the log would mean inventing two of its five event types, and
  a log that silently omits categories is worse than no log.
- **Any cross-community or platform-wide view.** One community at a time.
- **Date-range selection.** Six months, fixed.
- **Export.** No CSV, no download.

## Testing

**Every metric definition above gets a test that would fail if the definition
changed**, because a definition that lives only in a docstring is a definition
nobody can rely on. Specifically:

- A **pending** transaction moves neither the revenue total nor the success
  rate. One fixture holding paid, expired and pending transactions, asserting
  all three numbers at once — three separate fixtures would each let a
  mis-categorised status through.
- A community with **no transactions** reports `null` for both ratios, not
  `0`.
- A member who joined at **00:30 WIB on the 1st** counts in the new month.
  At the boundary, not at midday, for the reason every WIB test in this repo
  is written that way.
- A month with **no revenue** appears in the series as `0` rather than being
  absent — asserted on the series length and on the value.
- A tier with **no subscribers** appears in the distribution.
- **Another community's revenue, members and subscriptions are absent from
  this one's numbers.** One fixture with two communities under the same owner,
  driven from a table over all four panels — the shape every leak in this
  codebase has had, and the one a single-community fixture cannot catch.
- A **non-owner** and a **signed-out visitor** both get 403, and the response
  carries no numbers at all.

Per the repo's standing rule the gate is `bun test` and `bun run typecheck`.
No Playwright run and no dev server is part of this phase's verification —
which for a screen made entirely of numbers is worth stating plainly: the
tests prove the arithmetic, not that the dashboard is readable.

## Risks

**These are the first aggregate queries in the product, and they scan.**
Revenue over six months reads every paid transaction for a community. At
current volumes that is nothing; there is no index designed for it, and adding
one now would be designing for a load nobody has measured. The thing to watch
is the owner of a large community loading this tab, and the lever is an index
on `user_transaction` — noted here so the next reader knows it was considered
rather than missed.

**A wrong number looks exactly like a right one.** Every other phase in this
programme fails visibly — a broken gate 404s, a broken composer refuses. A
dashboard with a subtly wrong churn rate renders perfectly and is believed.
That is why each definition above is written down and asserted, and why both
ratios are `null` rather than `0` when they mean nothing.
