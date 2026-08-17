# The Member-Facing UI — Design Spec

Date: 2026-08-17
Status: Approved as the shape phases 2-6 build into
Parent: `docs/superpowers/specs/2026-08-17-user-accounts-design.md` (Phase 1 of the pivot)

## 1. What this document is, and is not

**This is not a buildable phase.** It is the UI shape that phases 2 through 6 of the pivot must
build into, agreed before any of them starts so they do not each invent a layout and then have to
be reconciled.

It was written because "make it look like Twitter" is a shape decision, not a styling one, and
retrofitting a shape across five phases is far more expensive than agreeing it once.

Each section names **which phase owns it**. A phase that touches the member-facing UI should be
checked against this document before its own spec is written.

## 2. The single most important thing: the feed will be empty

Twitter's shape assumes a populated follow graph. DIUDARA's will not have one. A new user follows
nobody, and with few accounts on the platform a following-only feed shows nothing to almost
everyone for months.

**So home is discovery-first.** `Beranda` has two tabs:

- **Untuk Anda** — the newest posts from everyone. **The default.**
- **Mengikuti** — only accounts you follow.

Untuk Anda is chronological, not ranked. Ranking is a project of its own and buys nothing until
there is enough volume for an ordering to matter.

Phase 3 owns this.

## 3. The shell

Four destinations, identical on both shapes:

| | |
|---|---|
| **Beranda** | the two-tab feed (§2) |
| **Jelajah** | find people |
| **Siaran** | who is live, and your own go-live |
| **Profil** | your own; anyone's at `/@handle` |

**Bottom tabs below `md`, a left rail at `md` and above.** The audience is Indonesian and
phone-first; bottom tabs are what they already have muscle memory for from WhatsApp, Instagram and
Twitter. The left rail exists because a creator managing tiers or going live wants the room.

**One `AppShell` component owns both shapes.** Two separately-maintained layouts drift, and this
project has already paid for the same rule being enforced in two places.

**Signup, login and the reset pages render outside the shell.** No navigation when there is no
session — every destination behind it requires one.

Phase 2 owns the shell.

## 4. Jelajah is people, not posts

Search by handle or display name, plus a plain list of accounts. This is the only answer to the
empty follow graph, and it is why it is a top-level destination rather than a search icon.

No algorithmic suggestions. "Newest accounts" and "accounts with the most followers" are enough at
this size, and both are one query.

Phase 2 owns this.

## 5. Locked content, which is the whole product

A members-only post appears **in place** in the feed and on the profile, with its caption readable
and its media replaced by a lock panel and **"Jadi anggota untuk melihat"**.

Visible locks are the conversion surface. A paywall nobody sees earns nothing, and a creator whose
profile shows three public posts looks abandoned when they are in fact posting daily.

**The cost, accepted deliberately:** a creator who posts mostly exclusives shows non-members a
column of locks. If that reads badly in practice, the fix is a per-profile summary line rather
than hiding posts — do not solve it by making exclusives invisible.

### 5.1 The rule that makes it real

**The API must never send the media URL to a non-member.** Not a signed URL, not a blurred variant,
not the original with a CSS filter over it. A browser that received the URL can fetch it, and a
paywall enforced in a React component is not a paywall.

The locked variant carries the caption, the author, the timestamp and the lock. Nothing else.

Phase 6 owns the gating. Phase 4 must build image delivery so that gating is *possible* — media
behind an endpoint that can check entitlement, not a public bucket URL.

## 6. The creator dashboard is absorbed, not restyled

`/dashboard/*` is a separate admin app for a separate kind of account. Under the pivot "creator"
stops being a kind of account, so **managing your own memberships belongs on your own profile and
in Pengaturan** — the same app your audience uses.

**Nothing in `/dashboard/*` gets restyled.** It keeps running untouched until phase 8 deletes it.
Restyling a surface scheduled for deletion is the clearest waste available here.

What moves, and where:

| Today, in the dashboard | Becomes |
|---|---|
| Tiers | your membership offer, edited in Pengaturan |
| Members | your subscriber list, on your own profile |
| Streaming | **Siaran**, a top-level destination |
| Activity | out of scope; revisit if anyone misses it |
| Channels (Telegram) | retired with phase 8 |

Phase 5 owns memberships moving; phase 7 owns Siaran.

## 7. `whatsapp_number` lives on `app_user`

Community owners currently receive no notification when somebody asks to join, because nothing in
the product can save an owner's own number. `creator.whatsapp_number` exists and is unreachable.

**The fix belongs on `app_user`, editable in Pengaturan** — which Phase 1 already built and where
the field already exists and is already editable.

**Deliberately not fixed sooner.** Adding the field to the retiring dashboard would work this week
and be deleted in phase 8. Until memberships re-point to users, owners see join requests by opening
the dashboard. Accepted knowingly on the grounds that free communities have no real members yet.

Phase 5 owns this.

## 8. What each phase owns

| Phase | Owns |
|---|---|
| **2 — profiles and following** | `AppShell`, both nav shapes, **Jelajah**, follow/unfollow, the profile screen, entry points from the landing page |
| **3 — posts and a feed** | `PostCard`, **Beranda** and its two tabs, composing a post |
| **4 — images** | upload, thumbnails, and **delivery through an endpoint that can check entitlement** |
| **5 — memberships** | tiers on a user, the subscriber list on a profile, `whatsapp_number` reaching notifications |
| **6 — exclusive content** | the locked variant, and the server-side gate of §5.1 |
| **7 — streaming re-pointed** | **Siaran** |
| **8 — retire Telegram** | deleting `/dashboard/*` and the channel machinery |

## 9. Deliberately out of scope

**Ranking.** Chronological until volume makes ordering matter.

**Notifications, likes, replies, reposts, DMs, bookmarks, hashtags.** Each is its own project and
none is needed for a creator to publish and be paid. Twitter's *shape* is being borrowed, not its
feature list.

**Dark mode.** One theme, done well.

**Video.** Transcoding is its own project; it slots in after images once there is evidence of what
people post.

## 10. Honest limitations

**Nothing links to the six account pages today**, and phase 2 is where that gets fixed. Until then
signup and login are reachable only by typing a URL — which is protective while `/users/*` proxying
in production is still unproven, but it means Phase 1 is not usable yet.

**This shape is unvalidated.** No user has used any of it. Discovery-first, visible locks and
bottom tabs are each defensible, and each is a guess. The cheapest correction point is after phase
3, when there is a feed to look at.

**Retiring the dashboard deletes working software**, including the free-communities and
join-request work merged on 2026-08-13. That was accepted when the pivot was chosen; it is restated
here so nobody reads phase 8 as a surprise.
