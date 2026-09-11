# Phase 7 — The live room, read as a broadcast studio

**Date:** 2026-09-12
**Programme:** `2026-09-09-udara-program-design.md`
**Follows:** Phase 6, `2026-09-11-creator-dashboard-design.md` (merged)
**Branch:** `feat/udara-liveroom`

## The decision this phase was blocked on

The programme said, in its own words, *"Do not start Phase 7 without that
decision"*. The decision is made and recorded in the programme document:

**A broadcast studio, not a conference.** Creators broadcast and members
watch. No SFU is adopted, no new server software is introduced, and no new
operational cost is taken on.

That single choice removes the largest element of the mockup and most of the
imagined cost of this phase. What remains is a **layout around a player that
already works**.

## What the mockup shows, and what survives the decision

`LiveRoomPage` in the reference is a dark full-bleed theatre: a back button, a
LIVE badge, the community and session name, a viewer count, the video filling
the centre, and a chat column down the right.

| Element | This phase |
|---|---|
| Full-bleed dark watch page | **Built** |
| The video | **Built** — the real HLS player, not the mockup's avatar placeholder |
| LIVE badge, title, broadcaster | **Built** |
| Participant strip | **Not built** — it is the conference feature, and in a broadcast there is one person on camera |
| Viewer count | **Not built** — see below |
| Chat column | **Not built** — see below |

### The participant strip is gone by the decision

`liveParticipants` in the mockup is four people with `speaking` and `muted`
flags. That is a call. In a broadcast there is exactly one person on camera,
so the strip would render one tile and mean nothing. It is not deferred; it is
not part of this product.

### The viewer count is deferred, and the reason is infrastructure

MediaMTX knows how many readers a path has, and offering that number looked
cheap. It is not, and this spec records why so the next reader does not
rediscover it:

- **MediaMTX's control API is not enabled.** There is no `api:` block in
  `infra/mediamtx.yml` and port 9997 is not exposed in
  `infra/docker-compose.yml`.
- **`MediaMtxAdapter` makes no network calls at all**, deliberately. Its
  docstring explains at length that MediaMTX asks *our* API to authorise every
  publish and read, so there is no provider call to make; the class is pure URL
  construction. A reader count would be its first outbound request, with a new
  unreachable-path failure mode and a test guard to stop the suite opening a
  socket.

So a real count is an infrastructure change to deployed config plus a new
failure mode, for one number on one page. It becomes its own small change when
it is wanted.

**Counting watch tokens instead was considered and rejected.** A token is
minted once per viewer and never says when they leave, so the number would
drift upward while looking authoritative. Phase 6's spec is about exactly this
— *a wrong number looks exactly like a right one* — and inventing one here
would contradict it.

### The chat column is Phase 8's

Live chat needs a realtime connection. The programme puts "new realtime"
in Phase 8 alongside DMs and notifications, and building a WebSocket layer
here would mean Phase 8 inherits infrastructure shaped around one use it did
not choose.

The page **leaves the column's space unused rather than stubbing a fake
chat**. A disabled input or a "chat coming soon" panel is a control for an
action that cannot happen — the rule Phase 1 set when it cut the tab bar
rather than render tabs with nothing behind them.

## Where watching happens today, and what changes

**Today:** `SiaranPage` is an INDEX of who is live and deliberately embeds no
player — its own comment records why, at length: a player per row minted a
watch token and began an HLS attach for streams nobody had chosen to watch,
and a failed attach turned a listing row into a large black error box.
Watching happens on the broadcaster's **profile**, where `ProfilePage` embeds
`StreamPlayer` among the profile's other content.

**After this phase:** there is a dedicated watch page, and the profile and the
index both link to it.

```
/siaran/:streamId
```

Under `/siaran`, which is already the streaming area and already in the Vite
proxy table, so no new proxy entry is needed — stated rather than left silent,
because `vite-proxy-coverage.test.ts` exists precisely because a missing entry
fails silently through the SPA fallback.

**The profile keeps its player.** It is not moved, and this is deliberate: a
visitor who lands on a broadcaster's profile while they are live should see
the broadcast there, not be bounced to another page. The watch page is the
*focused* way to watch, not the only way. Both use the same `StreamPlayer`
with the same token minting, so there is no second playback path to keep in
sync.

## The page

A full-bleed dark surface — the one screen in this app that is not the
ordinary light shell, because a video wants a dark surround and the mockup
agrees.

- **Top bar:** a back link out, the LIVE badge, the stream title and the
  broadcaster's handle linking to their profile.
- **Centre:** the player, filling the space, with the same `locked` handling
  `ProfilePage` already does — a non-member sees the "Jadi anggota untuk
  menonton" route rather than a player that would fail.
- **An unknown or ended stream** renders `NotFoundPage`, matching every other
  detail page in this app. A stream that ends while someone is watching is
  NOT force-navigated away: the player handles its own end-of-stream, and
  yanking a page out from under a viewer is worse than letting the video stop.

**No new API.** `GET /streams` already returns every live stream with its
`locked` flag and playback path; the page reads the one it needs by id. A
dedicated `GET /streams/:id` would be a second read path answering what the
existing one already answers.

## Not in this phase

- **The participant strip** — not deferred, not part of this product.
- **Live chat** — Phase 8, with the realtime layer.
- **The viewer count** — its own small change, once MediaMTX's control API is
  turned on.
- **Recording or replay.** Nothing stores a broadcast.
- **Scheduling a broadcast.** Phase 3's `kegiatan` can announce one; wiring an
  event to a live stream is a link this phase does not draw.

## Testing

- The page renders the player for a member and the membership route for a
  locked non-member — the same two branches `ProfilePage` already has, now
  asserted on their own page.
- An unknown id renders `NotFoundPage`; so does an id that is not live.
- The top bar carries the title and a working link back to the broadcaster.
- **`SiaranPage`'s rows and `ProfilePage`'s embedded player both keep working
  unchanged.** That is the proof this phase is additive; either needing an
  edit is a signal to stop.
- The route-table guard in `App.test.tsx` moves deliberately, as it has each
  phase.
- **No player is mounted before the page decides the viewer may watch.** The
  reason `SiaranPage` carries no player at all: a mounted player mints a token
  and starts an attach, and doing that for a viewer who is about to be shown a
  membership CTA is work for a stream nobody is watching.

Per the repo's standing rule the gate is `bun test` and `bun run typecheck`.
**This phase is mostly layout, and layout is exactly what those two cannot
check.** The tests prove which branch renders; they do not prove the page
looks right, and nobody has watched a real broadcast through it.

## Risks

**This is the first dark full-bleed screen in the app.** Every colour on it
falls outside the palette the rest of the product was contrast-checked
against, and `contrast.test.ts` only checks rules that set both a colour and a
background. A dark surface with inherited light-surface text tokens is the
obvious way to get this wrong, so the page sets its own foreground explicitly
rather than inheriting.
