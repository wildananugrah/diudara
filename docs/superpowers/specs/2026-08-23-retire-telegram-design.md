# Phase 8 — retire Telegram

Phase 8 of the DIUDARA pivot, and the last in the parent spec. Parent: `2026-08-17-member-ui-design.md`
(§6, §8). This is the phase every phase since 5a was shaped to make possible.

**Status: approved in conversation, awaiting written review.**

---

## 1. Purpose

Every phase since Phase 2 built the new world **beside** the old one rather than inside it, and paid a
tax for it: two tier tables, two subscription tables, two streaming tables, and a constraint in every
plan saying `/dashboard/*` and its six tables are untouchable.

**This phase collects on that.** 5a's spec put it plainly: *"Phase 8 becomes a deletion rather than an
untangling."* This is where that claim is tested.

## 2. The fact that shapes everything here

**The old world is a closed island.** Every foreign key among its tables points at another old-world
table; nothing in the new world references any of them. Measured, not assumed:

```
activity_log → community, member        join_request → community, creator, member, membership_tier
ai_conversation, ai_usage → creator     membership_tier → community
channel → community                     renewal_reminder → subscription
channel_membership → member             subscription → member, membership_tier
community → creator                     transaction → subscription
course → community                      event → community
enrollment → member                     event_rsvp → event, member
```

No edge points **into** that set from `app_user`, `post`, `post_media`, `follow`, `user_tier`,
`user_subscription`, `user_transaction`, `membership_reminder` or `user_stream`.

So this is a deletion, and the only real work is at the three seams where one file serves both worlds.

## 3. Decisions taken during brainstorming

| Decision | Choice | Why |
|---|---|---|
| Sequencing | **Build now, merge after the gates** | Five gate checklists are outstanding, and two cover things no test here can reach: Xendit has never been spoken to by new-world code, and Phase 7's nginx fragment and `u/` namespace have never served a request. Deleting the old world removes the fallback; holding the merge keeps it until the gates say the new world works. |
| The tables | **Code goes, tables stay** | A `DROP TABLE` is irreversible and this would be the most destructive migration in the project's history, run before the new world has served one real request. Dropping later is one small deliberate migration. |
| `schema.ts` | **Untouched this phase** | Drizzle generates migrations by diffing `schema.ts` against its snapshot. Removing the old definitions would make the next `db:generate` emit exactly the drops we just deferred. Leaving them is the *mechanism* that makes "tables stay" true. |
| Old creator accounts | **Gone with the code** | Nothing real exists in production (confirmed 2026-08-20). Migrating `creator` into `app_user` would be a feature, not a retirement. |

## 4. What goes

Roughly 130 files, in four groups:

- **The dashboard SPA** — all of `apps/web/src/dashboard/`, plus **four** files from
  `apps/web/src/pages/`: `CheckoutPage`, `StatusPage`, `RequestStatusPage` and `WatchPage`, the
  community-scoped checkout, join-status and watch screens.
  **`LandingPage` and `NotFoundPage` stay** — the landing page is the app's front door and carries the
  new app's entry points (parent §10), and the not-found page is generic. Naming the directory rather
  than the files would delete both.
- **Telegram and channels** — the bot adapter, channel machinery, channel access grants, join requests
  and their notifications.
- **Old streaming** — `event`, `event_rsvp`'s code, `ScheduleLiveSession`, `NotifyStreamLive`,
  `HandleStreamLifecycle`, `ResolveWatchToken`, `watch-token.ts`, and the `live/` namespace.
- **The old API** — routes, use cases, repositories and ports for communities, tiers, members,
  subscriptions, transactions, courses, enrollments and analytics; and the worker's `process-renewals`
  and `process-churn` passes.

The worker keeps `processOutbox`, `processMembershipReminder`, `processMembershipSweep`,
`processStalePendingSweep`, `processOrphanSweep` and `processUserStreamSweep`.

## 5. The three seams — where this phase can break the new world

Everything above is deletion. These are **surgery**, and each gets its own task.

### 5.1 `handle-payment-webhook.ts` — the money path

One Xendit stream, two kinds of subscription, told apart by `routeInvoiceExternalId` on an
`external_id` namespace (`usub_` for a user subscription). The community branch comes out.

**The rule 5a wrote for this file survives its own second world**: an **unrecognised prefix is
ignored, never assumed**. With only one kind left, the temptation is to treat "not recognised" as
"must be the surviving kind". That would activate a subscription against a payment for something else.
The three outcomes stay three: user, ignored, and — where it exists — malformed.

Amount verification and replay idempotency must not move. `webhook_event` **stays**: it is shared, and
it is what makes a replayed webhook safe.

### 5.2 `authorise-stream.ts` — every publish and every read

This file authorises both worlds. The `live/` namespace and `authoriseReadByEventId` come out, leaving
one entry in the allow-list.

**The allow-list stays an allow-list.** Phase 7 built it so an unrecognised prefix refuses rather than
falls through, and its own docstring records a defect where a looser parser authorised a publish to a
path the adapter never constructs. Collapsing it to "anything that parses is a user stream" reopens
exactly that.

### 5.3 `activity_log` — the table that straddles

Its foreign keys point at `community` and `member`, and `handle-payment-webhook` writes it. Since the
tables stay, **the table is untouched**; only its old-world writers go. Whether the new world should
keep writing it at all is a question for the follow-up that drops the tables, not for this phase.

## 6. Also folded in

Two cleanups deferred explicitly *to this phase*, each with its reasoning already recorded:

- **`PostEditUnitOfWorkPort`'s stale name.** `CreatePost` uses it too; the name says `Edit`. Deferred
  in Phase 6 as work that "should be its own reviewable commit rather than buried in a fix diff."
- **The HMAC duplication** between `watch-token.ts` and `user-watch-token.ts` — ~15 lines carried
  deliberately so the module being deleted was never coupled to the one being built. `watch-token.ts`
  is now the one being deleted, so the duplication resolves by subtraction.

## 7. Order

Leaves first, trunk last: the SPA, then Telegram and channels, then old streaming, then the old API,
then the three seams, then the two cleanups.

Deleting the SPA first means every later api deletion cannot break a page that still exists.

## 8. What proves it worked

**The test count will fall by thousands, and that is not the signal** — tests disappear with the code
they cover. A phase that only deletes needs different evidence:

- **The four new-world flows still work end to end**: compose and read a gated post; buy a membership;
  go live and watch; every remaining worker pass.
- **`isMemberOf` byte-identical**, as in every phase since 5a.
- **`bun run db:generate` produces no migration.** This is the proof that `schema.ts` still matches the
  database and nothing dropped a table by accident.
- **No dangling references**: typecheck green in all four workspaces, and no import resolving into a
  deleted module.
- **Each seam proven from the diff, not the suite.** A behaviour with no test moves silently, and
  Phase 7 established that reading the diff is the only way to catch it.

## 9. Out of scope

Dropping the tables, migrating `creator` rows into `app_user`, anything about `/dashboard`'s URL beyond
it no longer existing, `webhook_event`'s long-term shape, and any new feature.
