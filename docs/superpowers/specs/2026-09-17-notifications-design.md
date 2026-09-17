# Notifications — design

Status: implemented · 2026-09-17

## Why

The header has had a bell since the mockup and nothing behind it. `Header.tsx`
takes a `notificationCount` prop that no page has ever passed, deliberately:
its comment says a hardcoded number "would claim unread items that do not
exist". There is no table, no endpoint, no domain type. Meanwhile the Basic
tier advertises `"Notifikasi event"` as a benefit.

This gives a member one honest answer to "did anything happen that concerns
me?" — and only that.

## Scope

**In:** things addressed to the reader personally. Four families of event, five
events in total (one family — payment and membership — emits two):

| Event | Emitted by | Recipient |
|---|---|---|
| `post.commented` | `PostService.addComment` | the post's author; skipped when author == commenter |
| `payment.confirmed` | `CheckoutService.confirmPayment` | the buyer |
| `member.joined` | `CheckoutService.confirmPayment` | owner + admins of that community, minus the buyer |
| `membership.ended` | `MembershipService.removeMember` | the removed member |
| `message.sent` | `ChatService.send` | the other participant |

**Out, deliberately:**

- **Community broadcasts** ("new announcement in a community you joined"). One
  announcement would mean one row per member; the fan-out and the volume are a
  different feature. This means the `"Notifikasi event"` tier benefit is still
  unbacked — SPEC.md §6 gains a line saying so.
- **Likes.** High volume, low signal.
- **Email and push.** No mailer exists in this project (see the profile page,
  which says as much about email changes), and push needs device tokens and a
  service worker.
- **Real-time delivery.** The app polls everywhere else (chat 5s, live state
  15s, SPEC §6.4); notifications poll too.

## Decisions taken, and why

1. **Personal-only scope** — removes fan-out entirely, so a stored row per
   notification is cheap and no "broadcast + per-reader cursor" machinery is
   needed.
2. **Per-item `read_at`**, not a single `last_read_at` on the user. An item you
   skipped stays unread until you deal with it. The alternative (chat's
   pattern) clears everything the moment the panel opens.
3. **Delivered through an in-process event bus**, not direct calls. Services
   announce facts; a subscriber turns facts into rows. This was chosen over
   direct calls knowing it costs one indirection today for one consumer; the
   payoff is that email receipts or an audit log later subscribe without
   touching `PostService` at all. No new technology: ~40 lines of TypeScript,
   no broker, no dependency, no container.

## Data model

```
notifications
  id           text pk
  user_id      text not null → users(id) on delete cascade   -- the RECIPIENT
  type         text not null                                  -- see events above
  actor_id     text          → users(id) on delete set null   -- who caused it
  community_id text          → communities(id) on delete cascade
  entity_id    text                                           -- post/conversation/payment id
  data         jsonb not null default '{}'
  created_at   timestamptz not null default now()
  read_at      timestamptz

  index (user_id, created_at desc)
  index (user_id) where read_at is null      -- the badge count
```

`data` carries what the sentence needs, **captured at emit time**: actor name,
post title, community name, amount in cents. Not joined at read time, for two
reasons: a notification should still read correctly after the post is renamed
or the community is left, and joining four different shapes would leave most
columns null on most rows.

`entity_id` is deliberately untyped — it means "the thing this is about", and
the frontend knows what that is from `type`. `community_id` is the slug (this
schema uses slugs as community ids), so it doubles as the route segment.

**The API returns `type` + `data`. The frontend renders the Indonesian sentence
and decides the link.** UI copy is the frontend's job (CLAUDE.md), and routes
are a frontend concept.

### Payload per type

```ts
"post.commented"    { actorName, postTitle, postType, communityId }
"payment.confirmed" { communityName, tierName, amountCents }
"member.joined"     { actorName, communityName, tierName }
"membership.ended"  { communityName }
"message.sent"      { actorName, preview }   // preview: first 80 chars, trimmed
```

Money stays integer cents; the frontend formats it (`lib/format.ts`).

## The bus

```ts
// domain/events.ts
export type DomainEvent =
  | { type: "post.commented"; postId: string; authorId: string; actorId: string; ... }
  | ...

// domain/ports.ts
export interface EventBus {
  emit(event: DomainEvent): Promise<void>;
}

// infrastructure/events/InProcessEventBus.ts
export class InProcessEventBus implements EventBus {
  private handlers: Array<(e: DomainEvent) => Promise<void>> = [];
  subscribe(h: (e: DomainEvent) => Promise<void>): void;
  async emit(event: DomainEvent): Promise<void>;   // never rejects
}
```

**`emit` never rejects.** A subscriber that throws is caught and logged; the
action that triggered it still succeeds. A comment must not fail because a
notification did not save. The cost of that choice, stated plainly: a
notification can be silently missing and there is no retry. Acceptable for an
in-app bell; not acceptable for an email receipt, which is the point at which
the subscriber moves behind a job queue (`pgboss` over the Postgres already
running, rather than adding Redis).

Handlers run sequentially and are awaited inside the request, so the insert is
part of the request's latency — one indexed insert, measured in milliseconds.

**Wiring is a failure mode.** With direct calls, a missing collaborator is a
compile error. With a bus, a missing `bus.subscribe(...)` line compiles, runs,
raises nothing, and silently produces zero notifications forever. Mitigation is
mandatory, not optional: **a container test asserting that a freshly built
container has a subscriber registered, and that an emitted event reaches a
subscriber.** (Implemented as `container.test.ts`. It asserts delivery to a test
subscriber rather than a written row: the suite has no database, and adding one
for a single assertion would cost more than it proves.)

## API

All under `requireAuth`, all scoped to the token's user; no endpoint accepts a
user id from a path or body.

```
GET   /api/notifications?unreadOnly=true   newest first, max 50
GET   /api/notifications/unread-count      { count }
PATCH /api/notifications/:id/read          one item
PATCH /api/notifications/read-all          { updated }
```

`PATCH /:id/read` on a notification belonging to someone else returns **404,
not 403**: a stranger's notification id should not be confirmable as existing.

`unread-count` exists so the 30s badge poll costs one partial-index `COUNT`
rather than a list query with its payloads.

## Frontend

- **Bell** (`Header.tsx`) becomes a real button. Today it IS a `<button>`, but
  one with no `onClick` and a badge that never renders (an earlier note in this
  spec called it a `<div>`; corrected here). It gains: the unread count, a
  dropdown of the 10 most recent, and an empty state.
- **`/notifications`** — the full page the unfilled `pending_works` doc was
  named after. Grouped by day, each row links to its subject and marks itself
  read on the way, plus "Tandai semua dibaca".
- **Polling**: `unread-count` every 30s from the shell, so the badge is live on
  every page. The dropdown fetches the list only when opened.
- **Copy**: Bahasa Indonesia, rendered per `type` in one place
  (`lib/notificationCopy.ts` — a switch returning `{ text, link }`), so adding
  an event type touches one frontend file.

## Testing

- `NotificationService` (unit, fakes): each event produces the right row for
  the right recipient; a self-comment produces nothing; `member.joined` reaches
  every admin and never the buyer; read/read-all only ever touch the caller's
  own rows; a foreign id is 404.
- `InProcessEventBus` (unit): every subscriber receives the event; a throwing
  subscriber neither stops the others nor rejects `emit`.
- Emitting services (unit, fake bus): the event fires with the payload the
  subscriber needs, and it fires *after* the write it describes succeeds.
- **Container wiring** (integration): a built container has a subscriber, and a
  known event yields a row. This is the test that catches the silent no-op.
- Browser, two accounts: the recipient logic is proven rather than assumed —
  A comments on B's post, B sees the badge, A sees nothing.

## Risks and things knowingly accepted

1. **DM notifications duplicate the chat badge.** The sidebar already shows
   per-conversation unread from `last_read_at`. Two surfaces will report the
   same fact. Chosen deliberately.
2. **The table grows forever.** No pruning in this iteration. A
   `DELETE WHERE created_at < now() - interval '90 days'` on the same schedule
   as the watch-token prune is three lines whenever it is wanted.
3. **Best-effort delivery.** See the bus section: no retry, silent loss.
4. **One consumer today.** The bus is deliberate extensibility ahead of need,
   against CLAUDE.md's "avoid premature abstraction until a pattern repeats 3+
   times". Accepted with eyes open; the container test is the price.

## Out of scope for this spec, tracked for later

- Email receipts (needs a mailer + a job queue).
- Community broadcast notifications, which is what the `"Notifikasi event"`
  tier benefit actually promises.
- Notification preferences ("mute this community").
