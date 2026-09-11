# Phase 8a — Notifications

**Date:** 2026-09-12
**Programme:** `2026-09-09-udara-program-design.md`
**Follows:** Phase 7, `2026-09-12-live-room-design.md` (merged)
**Branch:** `feat/udara-notifications`

## Why Phase 8 is split

The programme's Phase 8 row reads *"DMs, Pulse-ID, notifications | FloatingChat,
AI onboarding, the bell | new realtime; `ai_conversation` tables exist
unused"*. That is four subsystems, and together they are larger than Phases 3
to 7 combined:

| | What it actually needs |
|---|---|
| Realtime layer | WebSockets. Nothing exists — there is no socket code in the API |
| DMs | New tables, a 441-line chat UI, and the realtime layer under it |
| Notifications | New tables, a bell, read state, and hooks into five shipped phases |
| Pulse-ID | An LLM provider, a conversation store, and a product decision |

**And the row's stated premise is out of date.** `ai_conversation` and
`ai_message` do NOT exist unused — they were dropped in migration `0034`, part
of Phase 1's clearing of the dormant set. There is also no AI provider left:
no adapter directory, and the `/ai` routes went with retire-telegram. The
programme already carries a correction note about that drop for other tables;
this row was missed, and this spec is where it is recorded.

**There is also an ordering constraint.** DMs, notifications and Phase 7's
deferred live chat all want the same realtime layer. Whichever is built first
shapes it — so building it inside "DMs" means notifications and live chat
inherit infrastructure designed around one use that did not choose it.

So:

- **8a (this spec) — notifications, on POLLING.** Real value, no new
  infrastructure, and it defers the realtime decision honestly rather than
  making it as a side effect.
- **8b — the realtime layer and DMs**, designed knowing it must serve DMs,
  notifications and live chat.
- **8c — Pulse-ID**, starting from what the onboarding is for.

## Goal

A bell in the header tells you what has happened to you: somebody commented
on your post, joined your community, subscribed to one of your tiers, or
followed you.

## The schema

### `notification`

```
id            uuid PRIMARY KEY
user_id       uuid NOT NULL REFERENCES app_user(id)   -- THE RECIPIENT
kind          varchar(32) NOT NULL
actor_id      uuid NOT NULL REFERENCES app_user(id)   -- who did the thing
post_id       uuid NULL REFERENCES post(id)
community_id  uuid NULL REFERENCES community(id)
read_at       timestamptz NULL
created_at    timestamptz NOT NULL DEFAULT now()
```

**`user_id` is the RECIPIENT, not the actor.** Named plainly because every
read path filters on it and getting the two the wrong way round would deliver
every notification to the person who caused it.

**No stored URL.** The row keeps the kind and the ids; the CLIENT builds the
link. Storing an href is the same mistake as storing a bucket URL —
`MediaView` records it — because routes change and the id is the identifier.

**Two nullable subject columns rather than one polymorphic id.** `post_id`
and `community_id` are real foreign keys, so a notification cannot point at a
row that never existed, and a deleted subject is visible to the query rather
than being a dangling uuid. A single `subject_id` with a `subject_type`
discriminator would buy one column and lose both guarantees.

**`kind` is a `varchar`, not an enum** — the reasoning `subscription.status`
and `post.type` already record: a fifth kind needs no migration.

### The indexes

```
index notification_user_created_idx on (user_id, created_at desc)
index notification_user_unread_idx  on (user_id, created_at desc) where read_at is null
```

The first serves the list, the second the unread count — partial, so read
notifications leave it entirely. The count is the query that runs every sixty
seconds for every signed-in user, and it is the one worth an index of its own.

## The four kinds

| `kind` | Recipient | Written when |
|---|---|---|
| `comment` | the post's author | somebody comments on their post |
| `join` | the community's owner | somebody joins their community |
| `subscribe` | the community's owner | somebody's subscription becomes active |
| `follow` | the followed user | somebody follows them |

**Narrow on purpose.** Every additional kind is a new way to be noisy, and a
bell nobody trusts is a bell nobody opens. New events in a community — a post,
an event, a document — are deliberately absent: they would fire for every
member of every community on every write, which is the shape of a
notification system people mute.

**Never notify yourself.** Commenting on your own post, joining your own
community and subscribing to your own tier all generate nothing. The rule
lives in one place, checked against `actor_id === user_id`, rather than in
four call sites that each have to remember.

## Writing them: after the action, best-effort

**This is the decision worth arguing with.**

A notification is written AFTER the action that caused it has committed, and a
failure to write one is logged rather than thrown.

The alternative — the same transaction — is atomic and tempting, and it is
wrong here: it means a bug in notifications makes **commenting fail**. Losing
a notification is a mild annoyance nobody can even detect; losing a comment is
data loss the author watched happen.

So the honest statement is: **a notification can be lost.** That is accepted,
and it is why nothing in the product is allowed to depend on one having
arrived. The bell is a convenience over state that is already readable
elsewhere — the post has its comments, the community has its members — never
the only route to something.

Each hook sits at the END of its use case, after the write it reports.

## The API

| Method | Path | Auth |
|---|---|---|
| `GET` | `/users/me/notifications` | required |
| `POST` | `/users/me/notifications/read` | required |

`GET` returns the most recent page and an `unreadCount` in one response —
the bell needs both and two round trips for one badge is two chances to show a
count that disagrees with the list under it.

`POST .../read` marks **everything** read. Not per-notification: opening the
bell is the act of reading them, and a per-row read state would be UI nobody
asked for over a feature whose whole job is to stop nagging.

**Under `/users/me`, which already exists** — `me/tiers`, `me/payout`,
`me/subscribers`, `me/membership-requests` are all there, so `notifications`
joins a literal segment set that `RESERVED_HANDLES`' guard test already
covers. It must be added to that list, exactly as `comments` was in Phase 2.

## Polling

The bell asks every **60 seconds**, and again when the tab regains focus.

That interval is the whole reason this phase needs no infrastructure. It is
also deliberately unambitious: a notification arriving up to a minute late is
not a product failure, and 8b's realtime layer can replace the polling without
changing the table, the endpoints or the UI.

**Polling stops when the tab is hidden.** A background tab asking every minute
forever is the kind of thing that shows up on somebody's battery.

## The web app

**A bell in the header**, beside what is already there, with an unread count
badge when there is one — and no badge at all when there is not, rather than a
zero.

Opening it shows the list and marks everything read. Each row is the actor's
name, what they did, when, and a link the CLIENT builds from `kind` and the
ids:

| `kind` | Link |
|---|---|
| `comment` | the post's discussion page |
| `join`, `subscribe` | the community |
| `follow` | the actor's profile |

**Signed out, there is no bell.** Not an empty one — absent, the rule Phase 1
set when it cut the tab bar.

## Not in this phase

- **Realtime delivery.** 8b.
- **Per-notification read state**, and notification preferences or muting.
- **Email or WhatsApp delivery.** The messaging adapter exists but pushing
  notifications out of the app is a separate product decision about consent.
- **New-content notifications** — a post, an event, a document. See **The four
  kinds**.
- **Any retention or cleanup.** Rows accumulate. At current volumes that is
  nothing, and a sweep is easy to add later; it is named under **Risks**
  rather than left to be discovered.

## Testing

**The risk in this phase is regression in five shipped paths, not bugs in the
new code**, and the tests are weighted that way:

- **Every existing comment, follow, join and subscription test stays green
  untouched.** That is the proof the hooks are additive. Any one of them
  needing an edit is a signal to stop and look.
- **A failing notification write does not fail its action.** Asserted with a
  repository that throws: the comment is still created, the follow still
  happens. This is the single most important test in the phase, because the
  failure it guards is silent in development and only appears when the
  notification path breaks in production.
- **Nobody is notified of their own action** — one table-driven test over all
  four kinds from one fixture, not four tests that each happen to remember.
- Reading marks everything read and the count goes to zero.
- A signed-out caller gets 401 from both endpoints.
- The unread count and the list agree in one response.

Per the repo's standing rule the gate is `bun test` and `bun run typecheck`.

## Risks

**Five shipped use cases gain a line each.** Comments, follows, joins and
subscription activation are all paths people already depend on, and the whole
value of "after the action, best-effort" is that a mistake in the new code
cannot break them. The test named above is what holds that.

**Rows accumulate forever.** Nothing deletes a notification. A busy community
owner generates one per join, and there is no sweep. This is fine at current
volume and is the first thing to revisit if the table grows — the worker
already runs five scheduled passes and a sixth is a small change.

**Polling is a per-user timer.** Sixty seconds times every signed-in tab is
the load this adds, and it is why the unread count gets its own partial index.
It is also the number to look at first if the API gets busy.
