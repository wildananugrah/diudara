# Phase 6: Creator Dashboard & Analytics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator can log in through a browser and run their business — create a community,
define tiers, connect a Telegram channel, connect payments, see member counts, gross revenue,
churn and tier distribution, read an activity feed, revoke a member, and export their member list.

**Architecture:** A new analytics repository whose reads are **creator-scoped at the port**, four
metrics endpoints, and a dashboard added to the existing `apps/web` beside the public checkout
pages. Plain hand-written CSS, no component library, no new runtime dependencies.

**Tech Stack:** Bun, Hono, PostgreSQL 16, Drizzle, Vite + React, `bun:test`,
`@testing-library/react` + happy-dom.

## Global Constraints

From `docs/superpowers/specs/2026-08-10-phase6-dashboard-design.md` and inherited from Phases 1-5.

- **Creator scoping lives in the repository, not the call sites.** These are the first
  creator-scoped reads of a table the worker writes unscoped. Phase 4's review praised
  `CommunityRepositoryPort` for having no unscoped lookup; Phase 3's one sanctioned exception
  (`findBySlug`, for public checkout) is documented at the port. Follow that.
- **Cross-tenant access returns 404, never 403.** Never reveal that another creator's resource
  exists.
- **Only `transaction.status = 'success'` counts toward revenue.** Phase 5 leaves `pending`,
  `failed`, and rolled-back settlements (`superseded`, `subscription_churned`) that must not be
  summed. Revenue is **gross** — Xendit's split rule deducts the platform fee — so the UI must
  label it as such or show the fee.
- **Amounts are integer Rupiah.** Format for Indonesian readers (`Rp 1.250.000`). Never floating
  point on money.
- **A reminder writes TWO `activity_log` rows** (`renewal_reminder_queued` and `_sent`) and only
  `_sent` means delivered. The feed must not show both; no count may double.
  `renewal_reminder_skipped` and `_not_sent` mean neither.
- **`renewed` and `joined` are distinct and must not be conflated.** A renewal is not a new member.
- **`renewal_reminder` rows are deleted on renewal** — they are a lock, not a history. Reminder
  history comes only from `activity_log`.
- **The JWT lives in `localStorage` and goes out as `Authorization: Bearer`.** Never log it, never
  put it in a URL, never render it. A 401 from any endpoint clears it and returns to login.
- Ports-and-adapters; Drizzle only; **generated** migrations only; never edit an applied migration
  (`0000`-`0013`).
- Bun throughout; root `bun run test` and `bun run typecheck` green across four workspaces. A
  workspace missing either script fails the whole root command.
- Tests use `resetDatabase()`; per-run test databases exist since Phase 5, so the suite is safe to
  run concurrently.

## Facts about the existing code — use these rather than rediscovering them

- `apps/web` currently holds `App.tsx`, `api.ts`, `main.tsx`, `pages/CheckoutPage.tsx`,
  `pages/StatusPage.tsx`. Routing is `react-router-dom` v7. `vite.config.ts` has a **`bypass`** on
  the `/c` proxy so a `text/html` navigation serves the SPA rather than the API — the dashboard's
  routes must not reintroduce that collision.
- `activity_log` indexes today: `pkey`, `member_id`, `community_id`. **No composite.**
- **The 14 real event types** written anywhere in the codebase:
  `joined`, `renewed`, `churned`,
  `renewal_reminder_queued`, `renewal_reminder_sent`, `renewal_reminder_skipped`,
  `renewal_reminder_not_sent`,
  `channel_access_granted`, `channel_access_revoked`,
  `access_manual_required`, `access_not_granted`, `access_not_revoked`,
  `churn_revoke_skipped`, `revocation_manual_required`.
  **Most are internal diagnostics.** A raw feed of `access_not_revoked` rows is noise at best and
  alarming at worst — Task 3 defines a creator-facing allowlist.
- Subscription statuses: `pending`, `active`, `past_due`, `churned`, `cancelled`, `superseded`.
  A member "counts" as a member when `active`; `past_due` still has access; `churned` does not.
- Existing endpoints the dashboard consumes: `POST /auth/signup`, `POST /auth/login`,
  `POST|GET /communities`, `PATCH /communities/:id`, `POST|GET /communities/:id/tiers`,
  `PATCH …/tiers/:tierId`, `POST|GET /communities/:id/channels`,
  `POST /communities/:id/members/:memberId/revoke`, `POST /payment-account`.
- Phase 2's `validate` middleware and `app.onError` already return Zod issues in a shape the UI can
  render field-level messages from.

---

### Task 1: The `activity_log` index

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Test: `apps/api/src/db/schema-phase6.test.ts`

**Interfaces:** adds `activity_log_community_event_created_idx` on
`(community_id, event_type, created_at)`.

This is first on purpose. The activity feed is the most-viewed screen in the product, and
`activity_log` grows with every payment, reminder, grant and revocation — so the table degrades
exactly as a creator becomes successful.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/schema-phase6.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { sql } from "./client";

describe("phase 6 indexes", () => {
  it("indexes activity_log the way the dashboard queries it", async () => {
    // The dashboard reads activity_log as `community_id + event_type + created_at`.
    // Without this index every feed page is a seq scan plus a sort, on a table
    // that grows with every payment, reminder, grant and revocation.
    const rows = await sql`
      select indexdef from pg_indexes
      where tablename = 'activity_log'
        and indexname = 'activity_log_community_event_created_idx'
    `;
    expect(rows.length).toBe(1);
    const def = String(rows[0].indexdef);
    expect(def).toContain("community_id");
    expect(def).toContain("event_type");
    expect(def).toContain("created_at");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && bun test src/db/schema-phase6.test.ts
```

Expected: FAIL — the index does not exist (`rows.length` is 0).

- [ ] **Step 3: Implement**

In `apps/api/src/db/schema.ts`, add to the `activityLogs` table's index list:

```ts
    index("activity_log_community_event_created_idx").on(
      table.communityId,
      table.eventType,
      table.createdAt
    ),
```

Then generate and apply:

```bash
bun run db:generate && bun run db:migrate
```

- [ ] **Step 4: Verify and commit**

```bash
bun test src/db/schema-phase6.test.ts
cd ../.. && bun run test && bun run typecheck
git add apps/api/src/db apps/api/drizzle
git commit -m "perf(analytics): index activity_log the way the dashboard reads it"
```

---

### Task 2: Metrics repository and the summary endpoint

**Files:**
- Create: `apps/api/src/application/ports/analytics-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-analytics.repository.ts`
- Create: `apps/api/src/application/use-cases/get-community-metrics.ts`
- Create: `apps/api/src/routes/analytics.ts`
- Modify: `apps/api/src/bootstrap.ts`, `apps/api/src/app.ts`
- Test: `apps/api/src/infrastructure/repositories/drizzle-analytics.repository.test.ts`
- Test: `apps/api/src/routes/analytics.test.ts`

**Interfaces:**
- `AnalyticsRepositoryPort` — **every method takes `creatorId` and scopes on it.** No unscoped
  variant exists.
  - `getMetricsForCreator(communityId, creatorId)` → `{ memberCounts, grossRevenueAmount, tierDistribution } | null`
- `GetCommunityMetrics.execute({ communityId, creatorId })`, throwing `NotFoundError` on null
- `GET /communities/:communityId/metrics` behind `requireAuth`

**Shape:**
```
{
  members: { active, pastDue, churned },
  grossRevenueAmount: number,   // integer Rupiah, SUCCESSFUL transactions only
  tierDistribution: [{ tierId, tierName, priceAmount, activeMembers }]
}
```

**The tests that matter more than the implementation:**

- **Revenue excludes what it must.** Seed transactions in `success`, `pending`, and `failed`, plus a
  rolled-back settlement, and assert the total counts **only** the successful ones. A creator
  seeing revenue they never received is worse than seeing none.
- **Cross-creator returns 404 and leaks nothing.** A stranger's token gets 404; assert the raw
  response text contains no member count, no amount, and no tier name.
- Member counts key off subscription status: `active` and `past_due` both still have access,
  `churned` does not — decide whether `past_due` counts as a member, **state it in a comment**, and
  test it. (Recommended: report it separately, as the shape above does, because "how many people can
  currently see my group" and "how many are paid up" are different questions a creator asks.)
- Tier distribution counts **active** members per tier and includes tiers with **zero** members —
  a tier nobody bought is exactly what a creator needs to see.

**Mutation-check:** remove the `creatorId` predicate from the repository query and confirm a test
dies. Phase 2 shipped a port whose absence of an unscoped read was the actual protection; this must
have the same property.

- [ ] **Steps:** failing tests → implement → mutation-check the scoping and the revenue filter →
  root gates green → commit `"feat(analytics): add creator-scoped community metrics"`.

---

### Task 3: The activity feed, with a creator-facing allowlist

**Files:**
- Create: `apps/api/src/domain/activity-feed.ts`
- Modify: the analytics port, repository, and routes
- Create: `apps/api/src/application/use-cases/get-community-activity.ts`
- Test: `apps/api/src/domain/activity-feed.test.ts`
- Test: extend `apps/api/src/routes/analytics.test.ts`

**Interfaces:**
- `activity-feed.ts` (pure, imports nothing): `CREATOR_VISIBLE_EVENTS` and
  `describeActivityEvent(eventType, metadata)` → an Indonesian label
- `listActivityForCreator(communityId, creatorId, { limit, before })` — **keyset pagination on
  `created_at`**, not offset, because the feed is append-heavy and offset drifts as rows arrive
- `GET /communities/:communityId/activity?limit=&before=`

**The substance of this task is deciding what a creator should see.** There are 14 event types and
most are internal:

- **Show:** `joined`, `renewed`, `churned`, `renewal_reminder_sent`, `channel_access_granted`,
  `channel_access_revoked`
- **Hide** (internal or duplicative): `renewal_reminder_queued` (the `_sent` row is the delivery),
  `renewal_reminder_skipped`, `renewal_reminder_not_sent`, `access_not_granted`,
  `access_not_revoked`, `churn_revoke_skipped`
- **Show as a warning needing action:** `access_manual_required`, `revocation_manual_required` —
  these mean automation could not complete and a human must intervene, which is precisely the thing
  a creator must not miss

**Required tests:**
- **A reminder produces exactly ONE feed entry**, not two. Seed both the `_queued` and `_sent` rows
  for one reminder and assert the feed length is 1. This is the trap the spec names: invisible until
  a creator counts by hand and finds twice what they expected.
- **`renewed` is not reported as `joined`.** A renewal is not a new member.
- Hidden diagnostic types never appear.
- Keyset pagination is stable when a new row is inserted between page 1 and page 2 — assert no row
  is skipped or duplicated. (Offset pagination fails this, which is why it is not used.)
- Cross-creator returns 404 and the response text contains no member identifier.

**On labels:** every member-facing string in this product is Indonesian, and the dashboard is for
Indonesian creators, so labels are Indonesian too. Keep them in the domain module so they are
testable without a browser.

- [ ] **Steps:** failing tests → implement → root gates green → commit
  `"feat(analytics): add the creator activity feed"`.

---

### Task 4: Member roster and CSV export

**Files:**
- Modify: the analytics port, repository, routes
- Create: `apps/api/src/application/use-cases/list-community-members.ts`
- Create: `apps/api/src/application/use-cases/export-community-members.ts`
- Test: extend the repository and route tests

**Interfaces:**
- `listMembersForCreator(communityId, creatorId, { limit, before })` → member rows with
  `{ memberId, name, whatsappNumber, tierName, status, joinedAt, nextBillingDate }`
- `GET /communities/:communityId/members`
- `GET /communities/:communityId/members.csv` — streams `text/csv` with a
  `Content-Disposition: attachment` filename including the community slug

**Requirements:**
- **CSV escaping is not optional.** A member name containing a comma, a double quote, a newline, or
  a leading `=`/`+`/`-`/`@` must not break the file or execute as a formula when opened in
  Excel/Sheets. Escape per RFC 4180 **and** neutralise formula-leading characters — a member could
  set their display name at checkout, so this is untrusted input reaching a creator's spreadsheet.
  Test each case.
- The export is **creator-scoped like everything else**; a stranger's token gets 404, not a file.
- It contains **WhatsApp numbers**, which are members' personal data. So: it must never be logged,
  the endpoint must be authenticated (no signed-link shortcut), and the plan notes for a future
  hardening pass that Indonesia's UU PDP 27/2022 applies.
- Stream rather than buffering the whole roster in memory.

- [ ] **Steps:** failing tests (including every CSV escaping case) → implement → root gates green →
  commit `"feat(analytics): add the member roster and CSV export"`.

---

### Task 5: Dashboard shell — auth, routing, layout

**Files:**
- Create: `apps/web/src/dashboard/` — `auth.ts`, `apiClient.ts`, `DashboardLayout.tsx`,
  `LoginPage.tsx`, `RequireAuth.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/main.tsx`, `apps/web/vite.config.ts`
- Create: `apps/web/src/styles.css` (or extend what exists)
- Test: `apps/web/src/dashboard/*.test.tsx`

**Interfaces:**
- `auth.ts` — `getToken()`, `setToken()`, `clearToken()` over `localStorage` under one key
- `apiClient.ts` — attaches `Authorization: Bearer`, and **on any 401 clears the token and
  redirects to login**. A stale 7-day token otherwise leaves the UI half-authenticated, which is the
  most confusing possible state.
- Routes: `/dashboard/login`, `/dashboard` (communities), `/dashboard/c/:communityId/*`
- `RequireAuth` redirects to login when there is no token

**Watch the proxy.** `vite.config.ts` already has a `bypass` on `/c` so a `text/html` navigation
serves the SPA instead of the API — Phase 4 hit that collision for real. The dashboard uses
`/dashboard/*`, which does not collide, but the proxy config must still forward the **new API
paths** (`/communities`, `/auth`, `/payment-account`) correctly. Verify a real browser navigation to
a deep dashboard URL serves the app, not JSON.

**Requirements:**
- The token is never logged, never in a URL, never rendered.
- Login shows a field-level error for a 400 and a generic one for a 401 — the API deliberately
  returns the same message for unknown email and wrong password, and **the UI must not undo that**
  by saying "no such account".
- Plain hand-written CSS. Mobile-aware, desktop-first is fine here.

- [ ] **Steps:** failing component tests (login stores a token and redirects; a 401 from a protected
  call clears the token; `RequireAuth` redirects when unauthenticated) → implement → verify a real
  browser navigation → root gates green → commit `"feat(web): add the dashboard shell and login"`.

---

### Task 6: Community screens — list, create, tiers, channels, payments

**Files:**
- Create: `apps/web/src/dashboard/pages/CommunitiesPage.tsx`,
  `CommunityOverviewPage.tsx`, `TiersPage.tsx`, `ChannelsPage.tsx`, `AccountPage.tsx`
- Test: one test file per page

**These are the screens that make the product operable.** Everything here already works over the
API and has never had a UI.

**Requirements:**
- **Surface prominently that a creator with no payment account cannot sell**, rather than letting
  them build tiers nobody can buy. `POST /payment-account` is on the Account screen; the
  Communities and Tiers screens should warn when it is not connected.
- **The Telegram channel form must say the chat id is numeric**, not `@username`, and explain where
  to find it. Phase 4 constrained this deliberately so a join can be matched back for revocation —
  a creator who enters `@name` would silently lose automated revocation.
- Show a community's **status and what it means**: `active` sells; `paused` renders the checkout page
  but rejects purchases; `archived` 404s.
- Prices are entered and displayed as **integer Rupiah**, formatted `Rp 1.250.000`.
- Show the community's public checkout link, copyable — it is the thing a creator broadcasts, and
  the whole product depends on them sharing it.
- 409s (payments already connected, slug taken) render inline with form state preserved.

- [ ] **Steps:** failing tests per page against a stubbed fetch → implement → root gates green →
  commit `"feat(web): add community, tier, channel and account screens"`.

---

### Task 7: Metrics, members and activity screens

**Files:**
- Create: `apps/web/src/dashboard/pages/MembersPage.tsx`, `ActivityPage.tsx`
- Modify: `CommunityOverviewPage.tsx` to render the metrics
- Test: one test file per page

**Requirements:**
- **Label revenue as gross**, or show the platform fee. Presenting a gross figure as "your revenue"
  misstates a creator's income — Xendit's split rule deducts DIUDARA's fee before they receive
  anything. This is a correctness requirement, not copy polish.
- Member counts are shown as three separate figures (`active`, `past_due`, `churned`) with a word on
  what each means — `past_due` members still have group access, which is the non-obvious one.
- Tier distribution includes zero-member tiers.
- The activity feed paginates with "load more" (keyset), newest first, and renders
  `access_manual_required` / `revocation_manual_required` as **warnings that need action**, visually
  distinct from ordinary events.
- The members screen offers revoke, with a confirmation, and surfaces the honest result: revocation
  reports `automated: false` when it could not act at the provider, and the UI must **not** claim
  success in that case.
- CSV export is a plain link/button to the `.csv` endpoint with the auth header attached.
- Empty states everywhere: no members yet, no activity yet, no tiers yet. A new creator sees all
  three on day one, and a blank panel reads as broken.

- [ ] **Steps:** failing tests per page → implement → root gates green → commit
  `"feat(web): add metrics, members and activity screens"`.

---

### Task 8: End-to-end verification and the phase gate

Not a coding task. **Fix whatever it surfaces.**

- [ ] Root `bun run test` and `bun run typecheck` green across four workspaces.
- [ ] Start Postgres, the API, the worker and the web app. Confirm each stays up.
- [ ] **In a real browser**, perform the flow a creator does on day one, recording actual output:
  1. sign up, then log in at `/dashboard/login`
  2. connect payments
  3. create a community; copy its public checkout link
  4. define an active tier
  5. connect a Telegram channel using a numeric chat id (and confirm the form rejects `@username`)
  6. in another tab, complete a member checkout via that link, and POST the webhook so the worker
     grants access
  7. back in the dashboard: member count, gross revenue, tier distribution all correct
  8. the activity feed shows the join — and **exactly one** entry per reminder once reminders exist
  9. export the CSV and open it; confirm a member whose name contains a comma and a leading `=` is
     escaped and does not execute as a formula
  10. revoke the member and confirm the UI reports the true outcome
- [ ] Confirm **no token, no invite link, and no WhatsApp number** appears in any log line, or in
      any URL, across all processes.
- [ ] Deliberately expire/corrupt the stored token and confirm the UI returns to login rather than
      showing a broken half-authenticated state.
- [ ] Run the full suite **3 times**; no flakes.
