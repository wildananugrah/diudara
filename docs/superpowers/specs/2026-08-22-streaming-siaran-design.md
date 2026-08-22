# Phase 7 — streaming re-pointed, Siaran

Phase 7 of the DIUDARA pivot. Parent spec: `2026-08-17-member-ui-design.md` (§3, §6, §8).
Builds on `2026-08-20-memberships-5a-design.md` / `2026-08-21-memberships-5b-design.md` (`isMemberOf`)
and `2026-08-21-exclusive-content-design.md` (the gate, and what a lock looks like).

**Status: approved in conversation, awaiting written review.**

---

## 1. Purpose

**Siaran** is the fourth destination in the shell, and the only one still showing a placeholder.

Live streaming already works in this codebase — it is the one piece of the old world that was built
well and never re-pointed. This phase moves it from communities to people, and gates it with the
paywall Phase 6 built.

## 2. The fact that shapes everything here

**MediaMTX calls our API to authorise every publish and every read.**

That is unusual and it is the whole reason this phase is tractable. Phase 6's hardest rule — *never
hand out a URL that outlives the check that produced it* — is already satisfied for video, because
there is no signed URL: every HLS segment request passes through `AuthoriseStream`.

What remains is not *whether* we can gate video, but **how stale a watch credential may be**. See §5.

## 3. Decisions taken during brainstorming

| Decision | Choice | Why |
|---|---|---|
| Scope | **Go live now. Nothing else.** | The old `EventsPage.tsx` is 994 lines of scheduling, RSVPs and recordings. Phase 8 deletes it; anything ported must earn its place, and none of that is needed for a creator to go live and be paid. |
| Who may watch | **Per-stream `public` \| `members`**, the same choice a post already carries | A public stream is the cheapest funnel a creator has; the good stuff stays gated. Reuses `isMemberOf` unchanged. |
| Watch credential | **Bound to the viewer, ~10 minute TTL, silently re-minted** | See §5. |
| Publishing | **Browser (WHIP) first, RTMP details shown too** | The audience is phone-first. OBS is desktop-only, so an RTMP-only Siaran would be a desktop feature in a phone-first product. Both URLs already come back from one `createSession` call. |
| Relationship to the old world | **A new user-scoped table beside `event`** | See §4. |

## 4. The model

**`user_stream`**

| Column | Notes |
|---|---|
| `id` | uuid |
| `owner_id` | → `app_user`. The person streaming. |
| `title` | what Siaran shows. Public even when the video is not — the same rule as a post's caption. |
| `visibility` | varchar, `public` \| `members` — the same column type and values as `post.visibility` |
| `stream_key` | the publish secret, from `newStreamKey()` |
| `status` | varchar, `live` \| `ended` |
| `started_at` | |
| `ended_at` | null while live |

Plus **partial `unique (owner_id) where status = 'live'`** — one live stream per person, arbitrated by
the database. Pressing *Mulai siaran* twice is an ordinary double-tap, and 5a established three times
over that a read-then-write against this shape loses the race.

### 4.1 Why a new table rather than generalising `event`

`event.community_id` references `community`, which `/dashboard/*` reads. Generalising it with a
nullable owner and a check constraint would put rows the dashboard has no concept of into the tables
the dashboard queries — **every dashboard query would need amending to exclude them**, which is
editing live code the parent spec says to leave untouched, to accommodate rows it should never see.

This is the same argument 5a made for `user_tier` and `user_subscription`, and it has the same payoff:
**Phase 8 becomes a deletion rather than an untangling.**

The honest cost: two streaming tables coexist until Phase 8, and `AuthoriseStream` serves both.

## 5. Watching, and how stale a credential may be

`POST /streams/:id/watch-token` checks `isMemberOf` — **unchanged**, the same single indexed query
Phases 5a, 5b and 6 all rest on — and mints a token carrying **the viewer's id, the stream's id, and a
~10 minute expiry**. The player re-mints silently while watching.

The existing token lives **six hours** and carries only a subscription id. Both facts matter: six hours
is long enough for a forwarded link to serve a group chat for an evening, and a token naming no viewer
cannot be reasoned about after the fact.

**A public stream needs no token.** Read authorisation resolves the stream by key, sees
`visibility = 'public'`, and allows — there is nothing to mint and nothing to refresh. The token
exists only for gated streams, and the mint endpoint refuses to issue one for a public stream rather
than handing out a credential that means nothing.

**What the new token does and does not buy, stated plainly:**

- It **does not** prevent sharing. A forwarded token works until it expires.
- It **does** cap the damage at one refresh interval, and — more importantly — **a shared token cannot
  be renewed**, because re-minting requires the member's session.
- A membership that **lapses mid-stream** stops access at the next refresh. That is Phase 5b's "no
  grace" applied consistently, rather than an exception carved out for video.

## 6. Two namespaces, one auth hook

`AuthoriseStream` already authorises every publish and every read, and today resolves an `event`. It
must now serve both worlds, and they are distinguished by a **path namespace** — `live/<key>` for the
old world, `u/<key>` for the new — **never by guessing**.

**An unrecognised prefix is refused.** This mirrors 5a's webhook rule exactly: one provider stream,
two kinds of row, told apart by an explicit namespace rather than by inference. That handler's
docstring already records that `foo/bar/<key>` once authorised a publish as readily as `live/<key>`;
the new prefix must not re-open that.

## 7. Going live, and the stream that never ends

*Mulai siaran* creates the row, calls `createSession`, and returns both URLs. The browser publishes
over WHIP. The RTMP URL and key sit in a collapsed block for a creator on a desktop with OBS.

**The failure mode this section exists for is a row that stays `live` forever.** If MediaMTX's stop
webhook is missed — a crash, a restart, a network blip — Siaran shows a ghost, and worse, the partial
unique index means **that creator can never go live again**.

So two triggers, and both are needed:

- **The lifecycle webhook** ends the stream normally. This is the path a person experiences.
- **An hourly sweep** ends any row that has been `live` longer than a maximum session length. This is
  hygiene, and it is the one that matters — this project has now shipped the same lesson three times,
  in the orphan-media sweep, the expired-membership sweep, and the stale-pending-checkout sweep.

**The sweep's rule is a cap on age, not a silence detector, and that is deliberate.** MediaMTX reports
`online` and `offline`; it is not polled. With nobody watching, no read authorisation fires either, so
there is no signal that distinguishes "publishing quietly to an empty room" from "gone" — and
inventing one would mean either a heartbeat MediaMTX does not send or querying its API, both of which
buy a precision this failure mode does not need.

**So the window must exceed any plausible broadcast**, because the cost of getting it wrong is cutting
off a stream that is genuinely running. It is a backstop against a lost webhook, not a liveness check.
A creator whose stream is ended early can start another one immediately; a creator blocked forever by
a ghost row cannot.

## 8. Siaran

Who is live, newest first, visible to everyone signed in or not.

A gated stream shows its **title and its owner**, with a lock where the player would be — the same
shape as a locked post, for the same reason parent §5 gives: *a paywall nobody sees earns nothing*.
Tapping the lock goes to the owner's profile, where the offer already lives.

Below the list, your own controls: a title, the *Khusus anggota* checkbox, and *Mulai siaran*.

## 9. Testing

Beyond the usual coverage, four things here are only provable in particular ways:

- **The auth hook must refuse an unknown namespace.** A test that only exercises `live/` and `u/`
  proves nothing about what the handler does with a third prefix, and the old handler's own docstring
  records that this was once a real defect.
- **A lapsed member's re-mint must fail.** This is where 5b's retirement work becomes visible, and it
  is the case a status-only check gets wrong.
- **The double-go-live race must be proven concurrently** against the partial index. 5a's lesson
  applies: the contender count is part of the assertion, four proved far too few, and the number that
  holds must be measured and recorded beside it. The pool must be warmed before contenders arrive —
  5b confirmed an unwarmed race test can measure connection serialisation rather than arbitration.
- **The sweep's window must be tested at its boundary in both directions** — a stream just inside it
  survives, one just outside is ended. A test with only clearly-stale rows passes against a window of
  any length.

## 10. Out of scope

Scheduling, RSVPs, recordings, chat, viewer counts, reactions, multiple simultaneous streams per
person, transcoding or quality selection, notifying followers that somebody went live, anything in
`/dashboard/*`, and any change to `isMemberOf`.
