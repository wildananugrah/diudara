# Profiles and Following Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app becomes navigable and social — four destinations behind one responsive shell, a way to find people, follow and unfollow them, and entry points from the front page.

**Architecture:** A minimal `follow` table with a partial-free unique index and a database CHECK against self-follows; counts computed rather than stored; one `AppShell` owning both nav shapes; Beranda and Siaran as honest placeholders that Phases 3 and 7 fill.

**Tech Stack:** Postgres + Drizzle, Bun + Hono (ports and adapters), Vite + React, `bun:test`.

## Global Constraints

From `docs/superpowers/specs/2026-08-18-profiles-and-following-design.md` and its parent `2026-08-17-member-ui-design.md`.

- **Four destinations, fixed:** Beranda, Jelajah, Siaran, Profil.
- **Bottom tabs below `md`, a left rail at `md` and above, from ONE shared component.** Two separately-maintained layouts drift.
- **Signup, login and the reset pages render OUTSIDE the shell.** No navigation without a session.
- **Jelajah searches `handle` and `display_name` ONLY — never email, never WhatsApp number.** Phase 1 went to real lengths so signup and password reset cannot test whether an email is registered; a search box accepting an email would undo all of it.
- **Follow and unfollow are idempotent.** Following someone you already follow is a **200**, not an error. On a phone a double-tap is the common case.
- **`follower_id = followee_id` is refused by a database CHECK**, not only a use-case guard, so it holds however the row arrives.
- **Counts are computed with `COUNT(*)`. No denormalised counter column.** Revisit only when a profile view measurably slows, and record the measurement.
- **The public profile projection stays `handle`, `displayName`, `bio`, `createdAt`** plus the two counts and, for a signed-in viewer, whether they already follow. **No email, no WhatsApp number, no id.** Assert on response keys, never on types — a bare `select()` returns every column regardless of what TypeScript says, and Phase 1's review found this invariant defended on only two of five paths.
- **The creator dashboard is NOT restyled.** It runs untouched until Phase 8. Restyling a surface scheduled for deletion is pure waste.
- **All copy in Bahasa Indonesia.**
- A failing `expect(<DOM element>).toBeNull()` **hangs `bun test`** (~178 s, 335 MB); there is a source-scan guard at `apps/web/src/test/no-hanging-dom-assertions.test.ts`. Count elements with `queryAllBy...().length` or assert booleans.
- Dashboard tests render under `<StrictMode>` via `renderPage` in `apps/web/src/dashboard/testing.tsx`; that is load-bearing. The new pages live in `apps/web/src/user/` — follow the closest precedent there.
- **Every `fetch()` path prefix needs a matching entry in `vite.config.ts`'s proxy table**, and there is now a test enforcing it. A missing entry killed all six of Phase 1's pages, the third instance of that bug in that file.
- Migrations are **Drizzle-generated only**: edit `apps/api/src/db/schema.ts`, then `bun run db:generate`. Never hand-write a file in `apps/api/drizzle/`.
- Root gates: `bun run test` and `bun run typecheck` from the repo root — **`bun run test`, never bare `bun test`**, which yields ~123 spurious failures because `apps/web` needs its own bunfig preload. Baseline: 2354 pass / 0 fail (shared 82, worker 38, web 383, api 1851).
- A dozen flakes are on record, all `apps/api` timestamp comparisons between a Bun-side clock and Postgres's `now()`, firing under CPU contention. Not yours — but **capture any `(fail)` line verbatim before re-running**; that discipline has been broken three times here and each time the sighting was lost.

---

### Task 1: The `follow` table and repository

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/00XX_*.sql` (generated)
- Create: `apps/api/src/application/ports/follow-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-follow.repository.ts` + `.test.ts`

**Interfaces:**
- Produces: `FollowRepositoryPort`. Tasks 2 and 3 consume it.

**Schema:**

```ts
export const follows = pgTable(
  "follow",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    followerId: uuid("follower_id")
      .notNull()
      .references(() => appUsers.id),
    followeeId: uuid("followee_id")
      .notNull()
      .references(() => appUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Following twice is ONE row, arbitrated by the database rather than by a
    // read-then-write — the same reason `join_request_community_member_pending_unique`
    // is a unique index. Two taps in the same instant cannot both insert.
    uniqueIndex("follow_follower_followee_unique").on(table.followerId, table.followeeId),
    // BOTH directions are read on every profile view: "who follows this person"
    // and "who they follow". Missing indexes on exactly this shape left the
    // renewal passes seq-scanning for a whole phase before anyone noticed.
    index("follow_followee_created_idx").on(table.followeeId, table.createdAt),
    index("follow_follower_created_idx").on(table.followerId, table.createdAt),
    // A CHECK, not only a use-case guard, so it holds however the row arrives —
    // a future bulk import, a manual fix, a second call site.
    check("follow_no_self", sql`${table.followerId} <> ${table.followeeId}`),
  ],
);
```

**`check` is exported by `drizzle-orm/pg-core` in this version — verified by import — but it is NOT yet imported in `schema.ts`.** Add it to that file's existing `drizzle-orm/pg-core` import alongside `index` and `uniqueIndex`, and make sure `sql` is imported from `drizzle-orm`. This is the schema's first CHECK constraint, so there is no precedent to copy from.

**The port:**

```ts
export interface FollowCounts {
  followers: number;
  following: number;
}

export interface FollowListRow {
  handle: string;
  displayName: string;
  bio: string | null;
}

export interface FollowRepositoryPort {
  /**
   * Idempotent: returns `false` when the row already existed, `true` when it was
   * created. Uses ON CONFLICT DO NOTHING rather than catching 23505 — a raw unique
   * violation ABORTS the enclosing Postgres transaction, so a catch yields a clean
   * error object and a dead transaction. See `drizzle-join-request.repository.ts`'s
   * `createPending` docstring, which explains the hazard in full.
   */
  follow(followerId: string, followeeId: string): Promise<boolean>;
  /** Idempotent: `false` when there was nothing to remove. */
  unfollow(followerId: string, followeeId: string): Promise<boolean>;
  isFollowing(followerId: string, followeeId: string): Promise<boolean>;
  countsFor(userId: string): Promise<FollowCounts>;
  listFollowers(userId: string, limit: number): Promise<FollowListRow[]>;
  listFollowing(userId: string, limit: number): Promise<FollowListRow[]>;
}
```

`listFollowers` and `listFollowing` join `app_user` and return **only** the three public fields. Do not return `id` — nothing downstream needs it, and a list of user ids is exactly the kind of thing that leaks into a URL later.

- [ ] **Step 1: Write the failing repository tests.** `follow` returns `true` then `false` for a repeat, with one row in the table; `unfollow` returns `true` then `false`; `isFollowing` reflects both; `countsFor` is correct after follow, unfollow and re-follow; `listFollowers`/`listFollowing` return the three public fields and **not** `id` or `email`, newest first.

- [ ] **Step 2: Write the failing self-follow test, at the database.** Insert `follower_id = followee_id` **directly through the driver**, bypassing the repository, and assert Postgres rejects it. A use-case guard would pass a test that goes through the use case; this one must prove the CHECK exists.

- [ ] **Step 3: Write the failing concurrency test.** Four simultaneous `follow` calls for the same pair produce **one** row and exactly one `true`. Use the `ArrivalLatch` helper the codebase already uses for `markPastDue` and `createPending` — a genuine rendezvous, not four promises fired in hope.

- [ ] **Step 4: Run them and confirm they fail** — `cd apps/api && bun test src/infrastructure/repositories/drizzle-follow.repository.test.ts`. Expected: missing-module error.

- [ ] **Step 5: Edit `schema.ts`, then `cd apps/api && bun run db:generate && bun run db:migrate`.** Open the generated SQL and confirm it contains the unique index, both single-direction indexes, **and the CHECK constraint**. Drizzle's `check()` is easy to get wrong — if the constraint is absent, fix the schema and regenerate rather than editing the SQL.

- [ ] **Step 6: Implement the port and repository.**

- [ ] **Step 7: Root gates, then commit** `"feat(follows): add the follow table and repository"`.

---

### Task 2: Following and unfollowing over HTTP

**Files:**
- Create: `apps/api/src/application/use-cases/follow-user.ts` + `.test.ts`
- Modify: `apps/api/src/application/use-cases/get-user-profile.ts` + `.test.ts`
- Modify: `apps/api/src/routes/users.ts` + `.test.ts`
- Modify: `apps/api/src/bootstrap.ts` + `.test.ts`

**Interfaces:**
- Consumes: `FollowRepositoryPort` (Task 1), `UserRepositoryPort.findByHandle`, `requireUserAuth`.
- Produces: `POST /users/:handle/follow`, `DELETE /users/:handle/follow`, `GET /users/:handle/followers`, `GET /users/:handle/following`, and `PublicUserProfile` gaining three fields.

**One use case, two directions**, because the handle lookup, the self-follow refusal and the 404 are identical:

```ts
execute(input: {
  followerId: string;
  handle: string;
  action: "follow" | "unfollow";
}): Promise<{ following: boolean }>
```

Order: normalise the handle with `normalizeHandle`; `findByHandle`, **404** if absent; **409** in Indonesian if the target is the caller — `"tidak bisa mengikuti akun sendiri"`; then `follow` or `unfollow`, and return the resulting state.

**Return the state, not whether it changed.** `{ following: true }` after a follow whether or not a row was created. That is what makes it idempotent from the client's side, and it is what the button needs to render.

**`PublicUserProfile` gains exactly three fields**, projected explicitly — never spread the record:

```ts
followerCount: number;
followingCount: number;
/** null when the viewer is signed out. Never inferred client-side. */
viewerFollows: boolean | null;
```

`viewerFollows` is `null` for an anonymous viewer, not `false` — the button renders "Masuk untuk mengikuti" for one and "Ikuti" for the other, and collapsing them would make a signed-out visitor look like a non-follower who could act.

The follower and following lists take an optional `limit`, defaulting to 50, capped at 100.

- [ ] **Step 1: Write the failing use-case tests.** Follow returns `{ following: true }`; following again returns the same and creates no second row; unfollow returns `{ following: false }`; unfollowing someone you never followed returns the same, no error; an unknown handle 404s; following yourself 409s with the exact Indonesian message; a handle with a leading `@` still resolves.

- [ ] **Step 2: Write the failing profile tests.** The response contains the two counts; `viewerFollows` is `true`, `false` and `null` in the three cases; and **assert the full key set** with `expect(Object.keys(body).sort()).toEqual([...])` so a spread cannot leak `email`.

- [ ] **Step 3: Write the failing route tests.** Both follow routes require a session (401 without one); both return 200 for a signed-in caller; the two list routes return the three public fields and 404 for an unknown handle.

- [ ] **Step 4: Run them and confirm they fail.**

- [ ] **Step 5: Implement, wire the four routes, and add `follows` to `Dependencies` in `bootstrap.ts`.** Note `bootstrap.ts` builds dependencies while `app.ts` mounts routes — the `/users` router is already mounted, so only the routes inside it are new.

- [ ] **Step 6: Root gates, then commit** `"feat(follows): follow, unfollow, and follower counts on a profile"`.

---

### Task 3: Jelajah — finding people

**Files:**
- Create: `apps/api/src/application/use-cases/explore-users.ts` + `.test.ts`
- Modify: `apps/api/src/application/ports/user-repository.port.ts`
- Modify: `apps/api/src/infrastructure/repositories/drizzle-user.repository.ts` + `.test.ts`
- Modify: `apps/api/src/routes/users.ts` + `.test.ts`, `apps/api/src/bootstrap.ts`

**Interfaces:**
- Produces: `GET /users/explore?q=` returning `{ results, newest, mostFollowed }`.

Three repository additions:

```ts
/**
 * Prefix search over `handle` and `display_name`, case-insensitive.
 *
 * NEVER matches email or whatsapp_number. Phase 1 went to considerable lengths so
 * signup and password reset cannot be used to test whether an address is
 * registered — see that spec's §5.1. A search box that accepted an email address
 * would undo all of it in one line. Handles and display names are public by
 * design and already browsable at `/@handle`; addresses are not.
 */
searchPublic(query: string, limit: number): Promise<FollowListRow[]>;
newestPublic(limit: number): Promise<FollowListRow[]>;
mostFollowedPublic(limit: number): Promise<FollowListRow[]>;
```

All three return the same `FollowListRow` shape Task 1 defined — three public fields, no id.

`mostFollowedPublic` counts through `follow_followee_created_idx`. At this size a `group by` is fine; the index makes it an index-only scan rather than a table scan.

**An empty or whitespace-only `q` returns `results: []`** and still returns both lists. That is not an error — it is the default state of the screen.

- [ ] **Step 1: Write the failing repository tests.** `searchPublic` matches a handle prefix and a display-name prefix, case-insensitively; returns the three public fields and **not** `email`; respects the limit. `newestPublic` orders by `created_at` descending. `mostFollowedPublic` orders by follower count descending and includes users with zero followers last.

- [ ] **Step 2: Write the failing enumeration-guard test, and make it explicit.** Seed a user whose email is `rahasia@example.com`, then `searchPublic("rahasia@example.com")` and `searchPublic("rahasia")` must both return **zero** rows. Name the test after the guarantee, not the mechanism — the next person to "improve" search needs to see why it is there.

- [ ] **Step 3: Write the failing use-case and route tests.** `GET /users/explore` with no `q` returns both lists and an empty `results`; with a `q` returns matches; requires no session (it is public); a 101-item limit is capped at 100.

- [ ] **Step 4: Run them and confirm they fail.**

- [ ] **Step 5: Implement and wire the route.**

- [ ] **Step 6: Root gates, then commit** `"feat(users): search and discovery for Jelajah"`.

---

### Task 4: The shell

**Files:**
- Create: `apps/web/src/user/AppShell.tsx` + `.test.tsx`
- Create: `apps/web/src/user/BerandaPage.tsx` + `.test.tsx`
- Create: `apps/web/src/user/SiaranPage.tsx` + `.test.tsx`
- Modify: `apps/web/src/App.tsx` + `App.test.tsx`, `apps/web/src/styles.css`

**Interfaces:**
- Produces: `AppShell`, and the routes `/beranda`, `/jelajah`, `/siaran` — Task 5 fills Jelajah.

**One component, two shapes, one source of destinations:**

```ts
const DESTINATIONS = [
  { to: "/beranda", label: "Beranda" },
  { to: "/jelajah", label: "Jelajah" },
  { to: "/siaran", label: "Siaran" },
  { to: "/pengaturan", label: "Profil" },
] as const;
```

Render that array **twice** from the same constant — a bottom bar and a side rail — and let CSS decide which is visible at `md`. Do not build two lists. Two separately-maintained navigations drift, and this project has already paid for the same rule living in two places.

**Profil points at `/pengaturan`** rather than `/@handle`, because the shell does not know the signed-in user's handle without a fetch, and a nav item that needs a network call before it can render its own `href` is the wrong trade. Settings links to your own public profile.

**Pages that must NOT be wrapped:** `/signup`, `/masuk`, `/lupa-sandi`, `/reset/:token`, and `/:handleParam`. The first four have no session; the profile page is public and viewable by strangers, so it renders standalone. Add a test asserting no nav renders on a signed-out signup page — that is the one a refactor breaks.

**Beranda and Siaran are honest placeholders**, not spinners:

- Beranda: `"Belum ada kiriman untuk ditampilkan."` plus `"Temukan orang untuk diikuti di Jelajah."` linking there.
- Siaran: `"Belum ada siaran langsung."`

Do not fake a loading state for content that does not exist. A skeleton that never resolves is worse than a sentence.

- [ ] **Step 1: Write the failing shell tests.** All four destinations render and navigate; the shell renders on `/beranda`, `/jelajah` and `/siaran`; it does **not** render on `/signup`, `/masuk` or `/@somehandle`; Beranda shows its empty copy and exactly one link to Jelajah. Count elements — never `expect(<DOM element>).toBeNull()`.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement `AppShell`, both placeholder pages, and the CSS.** The responsive switch is `@media (min-width: 768px)`; follow how `styles.css` already handles breakpoints rather than introducing a new convention.

- [ ] **Step 4: Add the routes to `App.tsx`.** They are static single-segment paths, so they must come **before** `/:handleParam` — which is registered last already. Confirm `App.test.tsx` still shows every existing route resolving.

- [ ] **Step 5: Root gates, then commit** `"feat(web): the app shell, with Beranda and Siaran placeholders"`.

---

### Task 5: Jelajah, the follow button, and the entry points

**Files:**
- Create: `apps/web/src/user/JelajahPage.tsx` + `.test.tsx`
- Create: `apps/web/src/user/FollowButton.tsx` + `.test.tsx`
- Create: `apps/web/src/user/FollowListPage.tsx` + `.test.tsx`
- Modify: `apps/web/src/user/apiClient.ts` + `.test.ts`
- Modify: `apps/web/src/user/ProfilePage.tsx` + `.test.tsx`
- Modify: `apps/web/src/pages/LandingPage.tsx` + `.test.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/vite.config.ts`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: every endpoint from Tasks 2 and 3.

**`vite.config.ts` needs no new entry** — `^/users/` already covers all of these. **Confirm that by running the proxy-table test rather than assuming it**, because a missing entry there killed all six of Phase 1's pages and that test exists precisely so nobody has to remember.

**`FollowButton` renders three states** from `viewerFollows`:

| value | button |
|---|---|
| `null` (signed out) | `"Masuk untuk mengikuti"`, links to `/masuk` |
| `false` | `"Ikuti"` |
| `true` | `"Mengikuti"` |

**It updates optimistically and reverts on failure.** A follow tap on a phone must feel instant; a spinner on a one-field write is worse than an optimistic flip. Because the API is idempotent, a double-tap is safe — but disable the button while a request is in flight so the count does not visibly bounce.

**Absent entirely on your own profile.** Comparing handles is enough; do not fetch anything extra to decide it.

**Jelajah** shows a search input plus the two lists, each row a link to `/@handle` with a `FollowButton`. Search on submit, not on every keystroke — debounced-search-as-you-type is a bigger component and this list is small.

**`FollowListPage`** serves `/@handle/pengikut` and `/@handle/mengikuti`, reachable by tapping the counts on a profile. Same row component as Jelajah.

**The landing page gains "Daftar" and "Masuk"** alongside the existing dashboard links. Leave the creator pitch as it is — it works and Phase 8 resolves the split-brain. Do not rewrite the copy.

- [ ] **Step 1: Write the failing tests.** `FollowButton` renders each of the three states; tapping `"Ikuti"` calls follow and flips to `"Mengikuti"`; a failed call reverts to `"Ikuti"`; it is absent on your own profile; it is disabled while in flight. Jelajah renders both lists and search results, and an empty query shows the lists without an error. The profile shows both counts, each linking to the right list. `FollowListPage` renders rows and an empty state. The landing page has links to `/signup` and `/masuk`, and its existing dashboard links still work.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement, and add the two `FollowListPage` routes to `App.tsx`** — both are three-segment paths, so they cannot be shadowed by `/:handleParam`.

- [ ] **Step 4: Run the proxy-table test** and confirm `^/users/` covers every new call. If it fails, the test is telling you something real.

- [ ] **Step 5: Root gates, then commit** `"feat(web): Jelajah, following, and entry points from the landing page"`.

---

### Task 6: End-to-end verification and the phase gate

Not a coding task. **Fix whatever it surfaces.**

- [ ] Root `bun run test` and `bun run typecheck` green.
- [ ] Kill stale Vite, API and worker processes; start fresh.
- [ ] **In a real browser, recording actual output:**
  1. from `/`, follow the new "Daftar" link, sign up, log in
  2. reach all four destinations from the nav, on a **narrow** viewport and a **wide** one
  3. from Jelajah, search for a second account you created, open its profile, follow it
  4. confirm the follower count changed and the button reads `"Mengikuti"`
  5. tap the count, see the list, unfollow from there
  6. sign out and open the same profile — the button must read `"Masuk untuk mengikuti"`
- [ ] **Confirm the enumeration guard by observation:** search Jelajah for an email address you know is registered and confirm it returns nothing.
- [ ] **Confirm the shell is absent** on `/signup`, `/masuk` and `/@handle` in a real browser, not just in tests.
- [ ] **Confirm the public profile response carries no email** — read the actual network response, logged out.
- [ ] **Confirm a double-tap on Ikuti produces one row** — click twice quickly, then `select count(*) from follow`.
- [ ] Confirm the **creator dashboard still logs in and works**, and that its styling is untouched.
- [ ] Run the full suite **3 times**; capture any `(fail)` line **verbatim before re-running**. A dozen `apps/api` timestamp flakes are on record and fire under CPU contention; anything else is real until proven otherwise.
