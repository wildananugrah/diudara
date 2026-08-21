# Phase 6 — exclusive content, the paywall

Phase 6 of the DIUDARA pivot. Parent spec: `2026-08-17-member-ui-design.md` (§5, §5.1, §8).
Depends on `2026-08-18-images-design.md` (media behind an endpoint) and
`2026-08-20-memberships-5a-design.md` / `2026-08-21-memberships-5b-design.md` (`isMemberOf`).

**Status: approved in conversation, awaiting written review.**

---

## 1. Purpose

Every phase so far built something a creator could give away. This one is the first where a creator can
**withhold** — and it is the reason the previous five exist.

5a made a membership purchasable. 5b made it keepable. Neither changed what a member *gets*. Phase 6
is what they get.

## 2. What the parent spec already settles

- **A members-only post appears in place** in the feed and on the profile — never hidden, never
  filtered out. Visible locks are the conversion surface, and a creator who posts daily exclusives
  must not look abandoned to a stranger (§5).
- **The caption stays readable**; the media is replaced by a lock panel reading **"Jadi anggota untuk
  melihat"** (§5).
- **The API must never send the media URL to a non-member** — not signed, not blurred, not the
  original behind a CSS filter. *"A paywall enforced in a React component is not a paywall"* (§5.1).
- **The accepted cost**: a creator who posts mostly exclusives shows strangers a column of locks. If
  that reads badly, the fix is a per-profile summary line — **not** making exclusives invisible (§5).

## 3. What Phase 4 already built for this

`GET /media/:id` and `GET /media/:id/thumb` read bytes out of `MediaStoragePort` and write them into
the response **by hand**, and they are two separate handlers rather than one with a `?thumb=1` flag.
Both facts are deliberate, and `media.ts` says why in a comment addressed to this phase:

> a redirect (302 to a signed URL, or to the bucket directly) would hand the caller a URL that
> outlives whatever check produced it, and Phase 6's gate would then be a decision this route makes
> once and the internet gets to keep forever.

Two handlers, so the router can gate them independently — *"not one line a future change could gate
halfway."*

**Nothing in this phase may turn either route into a redirect.**

## 4. Decisions taken during brainstorming

| Decision | Choice | Why |
|---|---|---|
| What a lock hides | **Media only** | §5 already says the caption stays readable, and the caption is the teaser that makes the lock convert. The honest cost is in §9. |
| Granularity | **Not tier-scoped** — any active membership to the author | `isMemberOf(viewerId, ownerId)` takes no tier, and 5b froze it as this phase's foundation. Tier-scoping would change the one query this whole phase rests on. |
| A members-only post with no image | **Refused, at the server** | The lock would protect nothing, and the creator would believe it did. See §7. |
| Changing the flag after publishing | **Both directions** | The edit flow exists since Phase 4. A mis-click should not cost a post its engagement. |
| Tapping the lock | **Go to the author's profile** | 5a's offer and the *Jadi anggota* button already live there, reviewed and mutation-tested, and correct for lapsed members since 5b's C-1 fix. No second payment surface. |
| What a locked post carries | **A count, no ids** | *"3 foto terkunci"* is a concrete tease that leaks only a number. |

## 5. The model

One column on `post`:

| Column | Notes |
|---|---|
| `visibility` | `varchar(16) not null default 'public'`, values `public` \| `members` |

**Varchar, not an enum** — the reasoning `subscription.status` and `user_tier.billing_cycle` already
record: a later value needs no migration.

**The default is load-bearing.** It makes the migration additive and turns every existing post public,
which is the only safe direction: a migration that defaulted to `members` would retroactively lock
content its authors published openly.

**No new index.** Locked posts appear in place, so the feed filters nothing — `post_live_created_idx`,
`post_author_created_idx` and the probe-row pagination are untouched.

## 6. The gate — two independent barriers

### 6.1 The projection

After a feed page (or a profile's posts, or a single post) loads its rows, **one batched query** asks:
*of these authors, which is this viewer an active member of?* One indexed query per page, whatever the
page size.

The query is one port method — `activeMembershipsAmong(viewerId, authorIds) -> Set<authorId>` — and
it answers for the whole page at once. It reads the same `status = 'active' AND current_period_end >
now()` predicate `isMemberOf` does, against the same partial unique index, **without changing
`isMemberOf` itself**.

A post is **locked** when `visibility = 'members'` **and** the viewer is neither the author nor an
active member. A signed-out viewer is `viewerId === null`, which locks every gated post — the same
`resolveViewerId` the feed already uses.

**Why not join it into the feed query.** A `LEFT JOIN user_subscription` inside the feed SQL would be
one query instead of two, but it would couple the feed's tuned query to the membership schema and bury
the paywall inside SQL that exists for another purpose. The gate should be a step a reader of the use
case can see and a test can point at.

**Why not ask per post.** A 20-post page from 12 authors would be 12 queries — the first thing to
surface when the feed slows down.

### 6.2 The media route

`GET /media/:id` and `GET /media/:id/thumb` resolve the viewer, load the row, and decide entitlement
**before a single byte is touched** — exactly where Phase 4's comment says to put it.

A refused request is **404, not 403.** Media ids are stripped from the projection, so they are not
public knowledge; a 403 would confirm which ids exist. 404 is also what both routes already return for
a missing row, so gated and absent are indistinguishable from outside.

### 6.3 Two kinds of row the gate must not trip over

- **Unclaimed media** (`post_id is null`) — bytes uploaded but not yet attached to a post. There is no
  post, so there is no visibility to read. These stay **ungated**, exactly as today: the id is known
  only to its uploader, who is the only person who could have received it.
- **Media on a soft-deleted post** (`post.deleted_at is not null`) — already unreachable through every
  projection. The route keeps serving it as it does today; this phase does not change deletion
  semantics. Recorded so the next reader knows it was considered, not missed.

### 6.4 Why both

**Neither is sufficient alone**, and this is the heart of the phase:

- The projection alone is not a paywall. A member holds legitimate ids and can pass them on.
- The route alone violates §5.1, which forbids *sending* the URL, not merely serving it.

The subscriber list in 5b established how this must be tested: three assertions downstream of one
chokepoint are one assertion. **Each barrier must be shown to hold with the other disabled.**

## 7. Composing and editing

`visibility = 'members'` **requires at least one image**, enforced on the server, for create and for
edit alike. Removing the last image from a locked post is refused by that same check — one rule in one
place, rather than two that can drift.

The composer disables *"Khusus anggota"* until an image is attached and says why. **That is a
courtesy, not the rule.** A client-side disabled state is the same category of mistake as a paywall in
a React component.

Flipping public → locked is **allowed**, with an honest note that people may already have seen it.
Not blocked: it is the creator's post and the creator's call.

## 8. The wire

`toPostView` gains a **required** `locked` parameter. Required rather than defaulted, for the reason
its own docstring already gives about `media`:

> a default would let a new call site forget it and silently publish every post as image-less

The same hazard applies here, with a worse outcome: a forgotten default publishes gated media.

A locked post carries `media: []`, `membersOnly: true`, `lockedMediaCount: n`. **`membersOnly` appears
on every post**, not only locked ones — the author and paying members need to know their own post is
gated.

The projection stays **closed** and asserted key-for-key, as every projection in this project is, in
**both** shapes.

### 8.1 Caching

Gated bytes go out `private, no-store`. Public media keeps `public, max-age=31536000, immutable`.

**The header is decided by the same check that decided the bytes.** Computed separately, the two can
disagree — and the failure mode is a shared cache holding gated images and handing them to strangers,
which no test of the route's status code would ever catch.

## 9. The honest limitation

**A creator whose exclusive is *writing* cannot protect it.** The caption is public by construction, so
this phase gates photographers, not essayists.

That is the right trade for a photo-first product whose parent spec calls the readable caption the
conversion surface, and it is recorded here so a later phase can revisit it deliberately rather than
discover it. If it is revisited, the shape is a separate public teaser field — **not** making the
caption conditional, which would turn one field into two meanings.

## 10. Testing

Beyond the usual coverage, five things here are only provable in particular ways:

- **The two barriers, independently.** Disable the projection gate and the route must still refuse;
  disable the route and the projection must still withhold. A test that only walks the happy path
  proves one barrier at most.
- **The lapsed member.** A member whose period ended must be refused — this is where 5b's retirement
  work becomes visible, and it is the case a status-only check would get wrong.
- **The cache header on a gated response must never say `public`.** Assert the literal header, not the
  status code.
- **The closed projection in both shapes** — locked and unlocked — with `Object.keys(...).sort()`. A
  spot-check passes against a leaked id, which is the entire failure mode.
- **The no-image rule at the server**, not only in the composer. A test that drives the disabled
  checkbox proves nothing about the API.

## 11. Out of scope

Tier-scoped gating, gating body text, blurred or partial previews, free-preview counts, scheduled
unlocking, per-post pricing, anything in `/dashboard/*`, and any change to `isMemberOf`.
