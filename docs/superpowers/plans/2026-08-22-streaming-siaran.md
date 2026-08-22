# Phase 7 — Siaran Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator goes live from their phone; members watch; strangers see a lock.

**Architecture:** A new `user_stream` table beside the old `event`, told apart at the MediaMTX auth hook by an explicit **path namespace** rather than by guessing. Watching a gated stream needs a short-lived token bound to the viewer, re-minted while watching, so a forwarded link cannot be renewed. Everything reuses `isMemberOf` unchanged.

**Tech Stack:** Bun 1.3.14, Hono, drizzle-orm, Postgres, React 19 + Vite, MediaMTX (RTMP / WHIP / HLS), `hls.js`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-22-streaming-siaran-design.md`

## Global Constraints

- **All user-facing copy is Bahasa Indonesia.** `NotFoundError` messages are English at every call site.
- **`/dashboard/*` and its six tables are UNTOUCHABLE**: `community`, `membership_tier`, `member`, `subscription`, `transaction`, `creator`. The old `event` and `event_rsvp` tables are equally off limits — this phase adds beside them, never edits them.
- **`isMemberOf` must not change** — `apps/api/src/application/use-cases/is-member-of.ts` is byte-identical to its Phase 5a form and pinned by an `EXPLAIN` test.
- **Never log a stream key, a watch token, an email, a WhatsApp number, or an invoice URL.** `handle-stream-lifecycle.ts` already states this rule for stream keys; it now covers tokens too.
- **Both guard tests live in `apps/web/src/test/`** — `no-raw-server-errors.test.ts` and `no-hanging-dom-assertions.test.ts`. There is no `apps/api` copy. That directory holds **three** files; run the whole directory, not two files by name.
- **Never put a DOM node on either side of an assertion that can fail** — it serialises the node's whole object graph and has OOM-killed this machine. Use `isNode` in `BerandaPage.test.tsx`, or compare `textContent` strings.
- Tests assert **literal values**, never the constant they check.
- **`toContain` and regex matchers accept a superstring** — they cannot see text appended to a string. Every user-facing string needs at least one assertion that fails when text is added to it.
- **Read the clock once per operation** and pass the `Date` down.
- **NEVER background the api suite.** It takes ~360s, so run it in the FOREGROUND with `timeout: 500000`. A backgrounded run does **not** wake a subagent — it parks, the coordinator has to notice and nudge it, and this has now stalled **eight** agents across three phases. If you catch yourself reaching for `run_in_background` or a Monitor to wait on a test run: don't. Pass the timeout instead.
- Never run a dev server, bind a port, or drive a browser.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/db/schema.ts` | `user_stream` + its partial unique index |
| `apps/api/src/application/ports/user-stream-repository.port.ts` | the port |
| `apps/api/src/infrastructure/repositories/drizzle-user-stream.repository.ts` | its queries |
| `apps/api/src/application/use-cases/authorise-stream.ts` | **one** parser, two namespaces |
| `apps/api/src/domain/user-watch-token.ts` | mint/verify, bound to a viewer |
| `apps/api/src/application/use-cases/start-user-stream.ts` | go live, one per person |
| `apps/api/src/application/use-cases/end-user-stream.ts` | the webhook path and the sweep's |
| `apps/api/src/routes/streams.ts` | `/streams` — list, start, end, watch-token |
| `apps/worker/src/scheduled-passes.ts` | the stale-live sweep |
| `apps/web/src/user/whip-publisher.ts` | **moved** out of `dashboard/` so Phase 8 does not delete it |
| `apps/web/src/user/SiaranPage.tsx` | who is live, and your own controls |
| `apps/web/src/user/StreamPlayer.tsx` | the HLS player, or the lock |

---

### Task 1: The table

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/<generated>.sql` (via `bun run db:generate`)
- Create: `apps/api/src/application/ports/user-stream-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-user-stream.repository.ts`
- Test: `apps/api/src/infrastructure/repositories/drizzle-user-stream.repository.test.ts`

**Interfaces:**
- Produces: `UserStreamRow { id, ownerId, ownerHandle, ownerDisplayName, title, visibility, streamKey, status, startedAt, endedAt }`, and `UserStreamRepositoryPort` with `startLive`, `findByStreamKey`, `findById`, `listLive`, `endById`, `listStaleLive`.

- [ ] **Step 1: Write the failing test**

```ts
test("one person cannot hold two live streams at once", async () => {
  await repo.startLive({ ownerId: rina.id, title: "Tanya jawab", visibility: "members", streamKey: "aaa" });
  await expect(
    repo.startLive({ ownerId: rina.id, title: "Lagi", visibility: "public", streamKey: "bbb" })
  ).rejects.toThrow(UniqueViolationError);
});

test("a stream that ENDED frees the slot — the same person can go live again", async () => {
  const first = await repo.startLive({ ownerId: rina.id, title: "Satu", visibility: "public", streamKey: "aaa" });
  await repo.endById(first.id, ENDED_AT);
  const second = await repo.startLive({ ownerId: rina.id, title: "Dua", visibility: "public", streamKey: "bbb" });
  expect(second.status).toBe("live");
});
```

The second test is the one that matters: a partial index that covered *every* row rather than only
live ones would pass the first test and fail this one, and the failure would look like "a creator can
never stream twice".

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && bun test drizzle-user-stream.repository.test.ts`
Expected: FAIL — the table does not exist.

- [ ] **Step 3: Add the table**

```ts
export const userStreams = pgTable(
  "user_stream",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull().references(() => appUsers.id),
    title: varchar("title", { length: 140 }).notNull(),
    // Same column type and values as `post.visibility`, for the same reason:
    // a varchar so a later value needs no migration.
    visibility: varchar("visibility", { length: 16 }).notNull().default("public"),
    streamKey: varchar("stream_key", { length: 128 }).notNull().unique(),
    status: varchar("status", { length: 16 }).notNull().default("live"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    // ONE live stream per person, arbitrated by the database. PARTIAL, so an
    // ended stream frees the slot — without the WHERE, a creator could stream
    // exactly once, ever.
    uniqueIndex("user_stream_one_live")
      .on(table.ownerId)
      .where(sql`${table.status} = 'live'`),
    // Siaran's listing: live rows, newest first.
    index("user_stream_live_started_idx")
      .on(table.startedAt.desc())
      .where(sql`${table.status} = 'live'`),
  ]
);
```

Then `bun run db:generate` and **read the generated SQL** — it must create one table and two indexes,
and touch nothing else.

- [ ] **Step 4: Write the repository, run, confirm green, commit**

`listLive` joins `app_user` for the handle and display name. **Select an explicit column list** — never
`select()` bare — so a later column cannot reach a caller by accident.

```bash
git add -A && git commit -m "feat(api): a user can hold one live stream at a time"
```

---

### Task 2: One parser, two namespaces

**Files:**
- Modify: `apps/api/src/application/use-cases/authorise-stream.ts:30-67`
- Modify: `apps/api/src/application/use-cases/handle-stream-lifecycle.ts` (its call site)
- Test: `apps/api/src/application/use-cases/authorise-stream.test.ts`

**Interfaces:**
- Produces: `parseStreamPath(path: string): { world: "community" | "user"; key: string } | null`.

**Read `streamKeyFromPath`'s docstring before you touch it.** It records that a looser parser once
authorised a publish to `foo/bar/<key>` exactly as `live/<key>`, marking an event live from a path this
codebase's own adapter never constructs. **Do not add a second parser.** Widen this one.

- [ ] **Step 1: Write the failing tests**

```ts
test("live/<key> is the community world", () => {
  expect(parseStreamPath("live/abc123")).toEqual({ world: "community", key: "abc123" });
});

test("u/<key> is the user world", () => {
  expect(parseStreamPath("u/abc123")).toEqual({ world: "user", key: "abc123" });
});

test("an UNKNOWN namespace is refused, never guessed at", () => {
  expect(parseStreamPath("foo/abc123")).toBeNull();
});

test("a three-segment path is refused even when its first segment is known", () => {
  expect(parseStreamPath("live/abc123/extra")).toBeNull();
});

test("a bare key with no namespace is refused", () => {
  expect(parseStreamPath("abc123")).toBeNull();
});
```

- [ ] **Step 2: Run, watch fail. Step 3: implement**

```ts
const NAMESPACES: ReadonlyMap<string, "community" | "user"> = new Map([
  ["live", "community"],
  ["u", "user"],
]);

export function parseStreamPath(path: string): { world: "community" | "user"; key: string } | null {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;
  const world = NAMESPACES.get(segments[0]!);
  if (world === undefined) return null;
  return { world, key: segments[1]! };
}
```

- [ ] **Step 4: Route `AuthoriseStream.execute` on `world`**

The community branch keeps its exact current behaviour. The user branch is added in Task 4 — for now
it refuses, and **a named test says so**, so the refusal is deliberate rather than accidental.

- [ ] **Step 5: Run the api suite, confirm nothing in the old world moved, commit**

```bash
git add -A && git commit -m "feat(api): two stream namespaces, told apart rather than guessed"
```

---

### Task 3: Going live

**Files:**
- Create: `apps/api/src/application/use-cases/start-user-stream.ts`
- Create: `apps/api/src/routes/streams.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/bootstrap.ts`, `apps/api/src/bootstrap.test.ts`
- Test: `apps/api/src/application/use-cases/start-user-stream.test.ts`, `apps/api/src/routes/streams.test.ts`

**Interfaces:**
- Consumes: `UserStreamRepositoryPort` (Task 1); `StreamingProviderPort.createSession({ streamKey }) -> { rtmpUrl, whipUrl, hlsPlaybackPath }`; `newStreamKey()`.
- Produces: `POST /streams` → `{ id, title, visibility, whipUrl, rtmpUrl, streamKey, hlsPlaybackPath }`; `DELETE /streams/:id` ends your own; **`GET /streams`** → `{ streams: [...] }`, which Task 6 renders.

**`GET /streams` is part of THIS task**, not Task 6's — a page cannot render an endpoint nobody built.
Its projection is **closed and gated**, exactly as a post's is:

```ts
// One row of GET /streams. `hlsPlaybackPath` is ABSENT — not null, absent —
// when the viewer is locked out: the projection must never send a playback
// path to somebody who may not watch, the same rule §5.1 states for media.
{ id, title, visibility, owner: { handle, displayName }, locked, hlsPlaybackPath? }
```

```ts
test("the listing's projection is CLOSED, and a locked row carries no playback path", async () => {
  const [gated] = (await get("/streams")).streams;
  expect(Object.keys(gated).sort()).toEqual(["id", "locked", "owner", "title", "visibility"]);
  expect(gated.locked).toBe(true);
});

test("an unlocked row carries the path", async () => {
  const [open] = (await get("/streams", memberAuth)).streams;
  expect(Object.keys(open).sort()).toEqual(
    ["hlsPlaybackPath", "id", "locked", "owner", "title", "visibility"]
  );
});
```

`locked` is decided server-side with `isMemberOf`, batched for the page the way Phase 6 batches a
feed's authors — the listing is short, but the shape should match what the feed already does.

- [ ] **Step 1: Write the failing tests**

```ts
test("returns both publish URLs and the key", async () => {
  const body = await post("/streams", { title: "Tanya jawab", visibility: "members" }, rinaAuth);
  expect(Object.keys(body).sort()).toEqual(
    ["hlsPlaybackPath", "id", "rtmpUrl", "streamKey", "title", "visibility", "whipUrl"]
  );
});

test("refuses a second live stream with a 409, not a second key", async () => {
  await post("/streams", { title: "Satu", visibility: "public" }, rinaAuth);
  const res = await request("/streams", { method: "POST", body: { title: "Dua" }, headers: rinaAuth });
  expect(res.status).toBe(409);
});

test("THIRTY simultaneous taps of Mulai siaran produce exactly ONE live stream", async () => {
  // ArrivalLatch, 30 contenders, pool WARMED before they arrive.
  expect(await countLive(rina.id)).toBe(1);
});
```

The concurrency test is not optional. 5a proved three times that a read-then-write against a partial
unique index loses, and **four contenders proved far too few** — measure the number that holds and
record it beside the test. Warm the pool first: `postgres.js` connects lazily, and 5b confirmed an
unwarmed race test can measure connection serialisation rather than the arbitration it names.

- [ ] **Step 1b: Handle a box with no streaming provider**

`Dependencies.streamingProvider` is `StreamingProviderPort | undefined` — **optional at boot**, exactly
like the payments provider, and `scheduleLiveSession` already models the pattern: the use case is
`undefined` exactly when the provider is. Follow it.

```ts
test("a box with no streaming provider refuses to start a stream, and says so", async () => {
  const res = await request("/streams", { method: "POST", body: { title: "Halo" }, headers: rinaAuth });
  expect(res.status).toBe(503);
});
```

**`GET /streams` must still work on such a box** — it lists rows from the database and needs no
provider. A listing that 503s because nobody configured MediaMTX would take Siaran down for readers
over a writer's dependency.

- [ ] **Step 2: Run, watch fail. Step 3: implement, letting the database arbitrate**

Insert and let `user_stream_one_live` refuse the loser; translate the unique violation into a 409.
**Do not check-then-insert.**

- [ ] **Step 4: Run, confirm green, mutation-test, commit**

Drop the unique index and confirm the thirty-tap test reddens.

```bash
git add -A && git commit -m "feat(api): a creator goes live, once at a time"
```

---

### Task 4: Watching

**Files:**
- Create: `apps/api/src/domain/user-watch-token.ts`
- Modify: `apps/api/src/application/use-cases/authorise-stream.ts` (the user branch)
- Modify: `apps/api/src/routes/streams.ts`
- Test: `apps/api/src/domain/user-watch-token.test.ts`, `apps/api/src/application/use-cases/authorise-stream.test.ts`, `apps/api/src/routes/streams.test.ts`

**Interfaces:**
- Consumes: `parseStreamPath` (Task 2); `isMemberOf`.
- Produces: `mintUserWatchToken({ viewerId, streamId, now, ttlMs, secret })`, `verifyUserWatchToken(token, secret, now)`; `POST /streams/:id/watch-token` → `{ token, expiresAt }`.

**Write a new token module. Do not widen `watch-token.ts`** — it serves the old world, which Phase 8
deletes, and widening it would couple a thing being removed to a thing being built.

`USER_WATCH_TOKEN_TTL_MS = 10 * 60 * 1000`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a PUBLIC stream authorises a read with no token at all", async () => {
  expect(await authorise({ action: "read", path: `u/${publicKey}`, query: "" })).toEqual({ allowed: true });
});

test("a MEMBERS stream refuses a read with no token", async () => {
  expect(await authorise({ action: "read", path: `u/${gatedKey}`, query: "" })).toEqual({ allowed: false });
});

test("a MEMBERS stream allows a read with a member's token", async () => { /* … */ });

test("a token minted for ANOTHER stream does not open this one", async () => { /* … */ });

test("an EXPIRED token is refused", async () => { /* … */ });

test("a tampered token is refused", async () => { /* … */ });
```

```ts
// routes
test("refuses to mint a token for a PUBLIC stream — there is nothing to gate", async () => {
  expect((await post(`/streams/${publicId}/watch-token`, {}, memberAuth)).status).toBe(400);
});

test("a LAPSED member cannot mint — their period ended", async () => {
  expect((await post(`/streams/${gatedId}/watch-token`, {}, lapsedAuth)).status).toBe(403);
});

test("the owner can always mint for their own stream", async () => { /* … */ });
```

- [ ] **Step 2: Run, watch fail. Step 3: implement**

Mint checks `isMemberOf` — **reuse it, never edit it**. The token carries `{ viewerId, streamId, exp }`.

- [ ] **Step 4: Run, mutation-test, commit**

Drop the `exp` check and confirm the expired test reddens. Drop the `streamId` comparison and confirm
the wrong-stream test reddens. **Both must redden**; a token that opens any stream is the same defect
class as Phase 6's forwarded media id.

```bash
git add -A && git commit -m "feat(api): a watch token names its viewer and dies in ten minutes"
```

---

### Task 5: Ending, and the stream that never ends

**Files:**
- Create: `apps/api/src/application/use-cases/end-user-stream.ts`
- Modify: `apps/api/src/routes/mediamtx-webhooks.ts` (the lifecycle route)
- Modify: `apps/worker/src/scheduled-passes.ts`
- Test: `apps/api/src/application/use-cases/end-user-stream.test.ts`, `apps/worker/src/scheduled-passes.test.ts`

**Interfaces:**
- Consumes: `UserStreamRepositoryPort.listStaleLive`, `.endById` (Task 1).
- Produces: `MAX_USER_STREAM_MS = 12 * 60 * 60 * 1000`; `formatUserStreamSweepLine(result): string | null`.

**Why a cap and not a silence detector:** MediaMTX reports `online`/`offline`; it is not polled, and
with nobody watching no read authorisation fires either — so nothing distinguishes "publishing quietly
to an empty room" from "gone". The sweep is a backstop against a **lost webhook**, so its window must
exceed any plausible broadcast.

- [ ] **Step 1: Write the failing tests**

```ts
test("the offline hook ends the stream", async () => { /* … */ });

test("a late ONLINE hook does not resurrect an ended stream", async () => { /* … */ });

test("the sweep ends a stream live longer than the cap", async () => {
  expect(await sweep(NOW)).toEqual({ considered: 1, ended: 1, failed: 0 });
});

test("leaves a stream ONE MINUTE inside the cap alone — somebody may still be broadcasting", async () => {
  expect(await sweep(NOW)).toEqual({ considered: 0, ended: 0, failed: 0 });
});
```

The fourth test is the one that keeps the cap honest: a suite with only clearly-stale rows passes
against a window of any length.

- [ ] **Step 2: Run, watch fail. Step 3: implement. Step 4: run, mutation-test, commit**

Shrink the cap to `now - 1000ms` and confirm the one-minute-inside test reddens.

```bash
git add -A && git commit -m "feat(api,worker): a stream ends, and a lost webhook cannot strand a creator"
```

---

### Task 6: Siaran — who is live

**Files:**
- Modify: `apps/web/src/user/SiaranPage.tsx`
- Create: `apps/web/src/user/StreamPlayer.tsx`
- Modify: `apps/web/src/user/apiClient.ts`
- Test: `apps/web/src/user/SiaranPage.test.tsx`, `apps/web/src/user/StreamPlayer.test.tsx`

**Interfaces:**
- Consumes: `GET /streams` (Task 3) and `POST /streams/:id/watch-token` (Task 4).

**`StreamPlayer` owns the re-mint.** For a gated stream it mints a token before attaching `hls.js`,
then re-mints on an interval shorter than `USER_WATCH_TOKEN_TTL_MS` (10 minutes) while playback runs,
and stops cleanly when a re-mint is refused — which is what a lapsed membership looks like from the
player's side. A player that mints once and never again works for ten minutes and then fails silently.

`locked` is computed server-side exactly as a post's is — **never in the component.** A paywall
enforced in React is not a paywall.

- [ ] **Step 1: Write the failing tests**

```tsx
test("a public stream renders the player", () => { /* … */ });

test("a gated stream renders the lock, the title, and the owner", () => {
  render(<SiaranPage />);
  const text = screen.getByTestId("siaran").textContent ?? "";
  expect(text).toContain("Bedah karya");
  expect(text).toContain("Jadi anggota untuk menonton");
});

test("the lock's copy is EXACT — catches text appended after it", () => {
  expect(screen.getByTestId("stream-lock").textContent).toBe("Jadi anggota untuk menonton");
});

test("no playback path for a gated stream reaches the DOM", () => {
  expect(document.body.innerHTML).not.toContain(".m3u8");
});

test("the empty state is honest", () => {
  expect(screen.getByTestId("siaran").textContent).toContain("Belum ada siaran langsung.");
});
```

The third test exists because `toContain` accepts a superstring — this phase's predecessor found three
tests blind to appended copy for exactly that reason.

- [ ] **Step 2: Run, watch fail. Step 3: implement. Step 4: run, confirm green. Step 5: commit**

```bash
git add -A && git commit -m "feat(web): Siaran shows who is live, and what you cannot watch"
```

---

### Task 7: Going live from the browser

**Files:**
- Move: `apps/web/src/dashboard/whip-publisher.ts` → `apps/web/src/user/whip-publisher.ts` (and its test)
- Modify: `apps/web/src/dashboard/pages/EventsPage.tsx` (import path only)
- Modify: `apps/web/src/user/SiaranPage.tsx`
- Test: `apps/web/src/user/SiaranPage.test.tsx`

**Move it, do not copy it.** `publishToWhip` is written, tested and working, and it currently sits in
`src/dashboard/`, which **Phase 8 deletes**. Moving it is the whole reason this is a step rather than
an afterthought. Update the old page's import and leave its behaviour untouched.

- [ ] **Step 1: Write the failing tests**

```tsx
test("Mulai siaran is disabled until a title is typed", () => { /* assert .disabled */ });

test("the OBS block shows the RTMP URL and the key after going live", () => { /* … */ });

test("Khusus anggota is sent as the visibility when ticked", async () => {
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ title: "Tanya jawab", visibility: "members" });
});
```

The third asserts the whole parsed body with `toEqual`, so both failure shapes fail it — sending the
wrong value, and sending nothing at all.

- [ ] **Step 2: Run, watch fail. Step 3: implement. Step 4: run, confirm green. Step 5: commit**

Copy, Bahasa Indonesia: `Mulai siaran`, `Akhiri siaran`, `Khusus anggota`, `Pakai OBS`, `Judul`.

```bash
git add -A && git commit -m "feat(web): go live from the browser, or from OBS"
```

---

### Task 8: The gate checklist

**Files:**
- Create: `docs/superpowers/sdd/2026-08-22-streaming-siaran/gate-checklist.md`

Written by the controller, run by the owner. It must cover what no suite here can prove:

- [ ] A real MediaMTX accepts a WHIP publish from a phone browser, and the stream appears in Siaran.
- [ ] A real OBS publish with the RTMP URL and key works too.
- [ ] A **signed-out** viewer sees the lock on a gated stream and **no `.m3u8` request succeeds** in the Network tab.
- [ ] A member watches; **let the token expire** (wait past ten minutes) and confirm playback continues — the silent re-mint works.
- [ ] Lapse that membership mid-stream and confirm playback **stops at the next refresh**.
- [ ] Kill MediaMTX mid-stream so the `offline` hook is lost; confirm the sweep ends the row and the creator can go live again.
- [ ] `/dashboard/*` streaming still works exactly as before.

---

## Self-Review

**Spec coverage.** §4 model → Task 1. §6 namespaces → Task 2. §7 going live → Task 3, §7's sweep →
Task 5. §5 watching → Task 4. §8 Siaran → Tasks 6, 7. §9 testing → distributed. §10 out of scope →
respected.

**Gap found and fixed in review:** Task 6 consumed a `GET /streams` that no task built — the same
shape of defect that reached execution in Phase 6, where the composer's value had nowhere to travel.
It now belongs to Task 3, with its closed projection specified there.

**Type consistency.** `parseStreamPath` (Task 2) is consumed by Task 4's user branch.
`UserStreamRepositoryPort`'s methods (Task 1) are called in Tasks 3, 4 and 5 with those exact names.
`mintUserWatchToken` / `verifyUserWatchToken` (Task 4) are the only token functions the new world uses;
`watch-token.ts` is untouched. `MAX_USER_STREAM_MS` (Task 5) is named once and asserted as a literal.
