# Phase 8b — Direct messages, on polling

**Date:** 2026-09-12
**Programme:** `2026-09-09-udara-program-design.md`
**Follows:** Phase 8a, `2026-09-12-notifications-design.md` (merged)
**Branch:** `feat/udara-dms`

## Goal

Two people who share a community can send each other messages.

## Why polling, and not the realtime layer this phase was named for

8b was scoped as "the realtime layer and DMs". Two findings changed that, and
both are about deployment rather than code.

**The API is a SINGLE process.** `ecosystem.config.cjs` runs one
`diudara-api` under PM2 with no `instances` setting, so an in-memory socket
registry would work with no Redis and no broker. Recorded because it is the
assumption any future socket layer rests on: scaled to two processes, a socket
held by one would not see a message published on the other.

**nginx as deployed cannot carry a WebSocket.** No `location` block in
`infra/nginx/api-proxy.conf.template` sets `proxy_http_version 1.1` or the
`Upgrade`/`Connection` headers, and nginx's default 60-second
`proxy_read_timeout` would close an idle socket anyway. Real-time DMs
therefore need a change to deployed config, rolled out to the VPS, before a
single message could arrive.

**So this phase polls**, and the repo owner chose that knowingly. A chat
polling every three seconds while its window is open is close enough to live
for a product at this stage, reuses the pattern Phase 8a's bell already
established, and needs nothing deployed.

**The cost, stated plainly:** a message can be up to three seconds late, and
the conversation LIST up to ten. Typing indicators and presence are not
merely unbuilt but impractical on this design.

**Nothing here forecloses sockets.** The tables, the endpoints and the UI are
all unchanged by a later switch — a socket layer replaces the polling
*underneath* `useMessages`, and Phase 7's deferred live chat is the second
consumer that would justify building it.

## The schema

### `conversation`

```
id                   uuid PRIMARY KEY
lower_user_id        uuid NOT NULL REFERENCES app_user(id)
higher_user_id       uuid NOT NULL REFERENCES app_user(id)
lower_last_read_at   timestamptz NULL
higher_last_read_at  timestamptz NULL
created_at           timestamptz NOT NULL DEFAULT now()

unique (lower_user_id, higher_user_id)
check  conversation_ordered_pair: lower_user_id < higher_user_id
```

**The participants are stored in a CANONICAL ORDER, and the CHECK is what
makes the UNIQUE mean anything.** A conversation is between two people and
there must be exactly one of it. Stored as `(a, b)` in whatever order the
opener happened to be, the same pair yields two rows depending on who spoke
first — and neither participant would see the other's messages, which is the
worst failure this feature has: it looks like the other person is ignoring
you.

Sorting by uuid is arbitrary but total, which is all a canonical form needs.
The CHECK holds it however the row arrives — a future import, a manual fix, a
second call site — the reasoning `follow_no_self` already records.

**There is no `conversation_no_self`.** Messaging yourself is refused by the
use case, and the CHECK above already makes it impossible to store: `x < x`
is false.

### `direct_message`

```
id               uuid PRIMARY KEY
conversation_id  uuid NOT NULL REFERENCES conversation(id)
sender_id        uuid NOT NULL REFERENCES app_user(id)
body             text NOT NULL
created_at       timestamptz NOT NULL DEFAULT now()

index direct_message_conversation_created_idx on (conversation_id, created_at)
```

**No soft delete.** Posts and comments have one because they are public and a
deletion is moderation; a message is between two people and this phase ships
no way to delete one. Adding the column now would be a column nothing writes
and whose meaning the first person to use it would decide.

**Oldest first**, matching the comment thread and unlike the feed — a
conversation reads top to bottom.

### Read state is two columns, not a table

`lower_last_read_at` and `higher_last_read_at` on the conversation. The unread
count is "messages in this conversation newer than my timestamp that I did not
send".

A per-message read table would be a row per message per reader, for a feature
whose entire job is to show one number. The timestamp also degrades correctly:
a reader who never opens a conversation has `null`, which means everything is
unread, which is exactly right.

## Who may start one

**Only somebody you share a community with.**

That is where the reference opens chat from — a member card inside a
community — and it means direct messages are not an open channel from any
account on the internet to any other. A product with open DMs and free signup
has a spam problem it did not choose.

**Once a conversation exists, either party may reply**, regardless of whether
they still share a community. Closing a thread retroactively because somebody
left a community would strand it mid-sentence, and the person who left is not
thereby a stranger.

The check therefore runs on **creating** a conversation, never on sending
into one that exists. That asymmetry is deliberate and is the whole rule.

## The API

| Method | Path | Auth |
|---|---|---|
| `GET` | `/users/me/conversations` | required |
| `POST` | `/users/me/conversations` | required — body `{ handle }` |
| `GET` | `/users/me/conversations/:id/messages` | required, participant only |
| `POST` | `/users/me/conversations/:id/messages` | required, participant only |
| `POST` | `/users/me/conversations/:id/read` | required, participant only |

**Under `/users/me`, like `me/notifications`** — and, as Phase 8a discovered
the hard way, that needs NO `RESERVED_HANDLES` entry: the reservation is for
literal segments directly under `/users`, and these sit a level deeper. The
guard test derives its list from the route table and is the authority.

**`POST /users/me/conversations` is idempotent.** Opening a chat with somebody
you already have a conversation with returns the existing one rather than
failing. The client's flow is "message this person", and it should not have to
know whether that thread exists.

**A non-participant gets 404, not 403**, on every `:id` route — the rule the
media and document gates already follow. A 403 would confirm that a
conversation with that id exists.

**The list returns, per conversation:** the other person's handle and display
name, the last message's body and timestamp, and the unread count. All in one
response, so the list cannot render a row whose preview disagrees with its
badge.

## Polling

**Follows what is on screen:**

| State | Interval |
|---|---|
| Panel closed | nothing at all |
| Panel open, showing the list | 10 seconds |
| Panel open, showing a thread | 3 seconds |

Paused while the tab is hidden and re-fetched immediately on focus — the
shape Phase 8a's bell established, for the same battery reason.

**Sending re-fetches immediately** rather than waiting out an interval, so
your own message never appears to lag.

## The web app

**A floating chat panel**, reachable from the header beside the bell, and from
a member's row in a community roster — which is where the reference opens it.

Closed by default. Opening shows the conversation list; choosing a row shows
the thread with a composer.

**Nothing renders when signed out**, the rule Phase 1 set and Phase 8a
repeated.

**Message bodies are plain text nodes**, never `dangerouslySetInnerHTML` —
`PostCard`'s comment records why for exactly this class of untrusted input.
`MAX_MESSAGE_BODY_LENGTH` is shared from `@diudara/shared`, the rule
`media.schema.ts` states: a limit declared twice drifts, and drifting high
means the client promises what the server refuses.

## Not in this phase

- **WebSockets.** See the top. The second consumer that would justify them is
  Phase 7's live chat.
- **Typing indicators and presence.** Polling cannot do them well, and a
  "typing…" that is three seconds stale is worse than none.
- **Attachments.** The reference's chat shows them. The media pipeline exists,
  but claiming an image into a message is its own decision about who may then
  fetch it, and `MediaEntitlement` currently answers only for posts.
- **Deleting or editing a message**, and blocking or reporting a person. The
  last is the real gap and is named in **Risks**.
- **Group conversations.** Two participants, enforced by the schema.
- **Notifying on a new message.** Phase 8a's bell has three kinds and this
  would be a fourth, but an unread badge on the chat panel already says it,
  and two separate counters for the same fact is how they disagree.

## Testing

- **The canonical pair, from both directions.** A conversation opened by A
  with B and one opened by B with A are the SAME row — asserted by opening
  from both directions in one test and comparing ids. This is the failure that
  looks like being ignored, so it gets the test that cannot pass by omission.
- **The CHECK refuses a reversed pair** written directly, so the guarantee
  holds below the use case too.
- **Starting a conversation with somebody you share no community with is
  refused**, and starting one with somebody you do is allowed — one fixture
  holding both people and one community, driven from a table.
- **Replying still works after the shared community is left.** The asymmetry
  is the rule; a test that only ever checks creation would not notice it
  being applied to sends as well.
- **A non-participant gets 404 on every `:id` route** — table-driven over all
  three, not three tests that each remember.
- **Unread counts exclude your own messages**, and a conversation never opened
  counts everything.
- Messages are oldest first; the list is by most recent activity.
- Signed out is 401 on every route.

Per the repo's standing rule the gate is `bun test` and `bun run typecheck`.

## Risks

**There is no blocking and no reporting.** The shared-community rule narrows
who can open a conversation, and nothing stops what they then say. That is a
real gap for a product with open signup, and it is the first thing to build
after this — named here rather than discovered by somebody being harassed.

**Polling scales with open panels, not with users.** Only an open chat polls,
which bounds it — but a thread at three seconds is twenty requests a minute
per open conversation, and that is the number to watch before it is the number
to fix.

**Two counters for one idea.** The bell counts notifications and the chat
panel counts unread messages. They are deliberately separate and must stay
that way; merging them later means deciding what a single number means when
half of it is a message.
