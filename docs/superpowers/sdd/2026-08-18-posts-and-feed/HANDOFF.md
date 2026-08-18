# Hand-off: DIUDARA Phase 3 — posts and a feed

**Read this first, then `progress.md` in this same directory.** You are picking up a phase that is
mid-flight. Everything here is true as of commit `a6eb4e3` on `main`.

---

## 1. What this project is

DIUDARA is an Indonesian SaaS, mid-way through a deliberate pivot: it used to be a Telegram-access
gateway for paid communities, and it is becoming a platform where the community itself lives —
people follow each other, post, stream, and sell memberships that gate exclusive content.

The pivot runs in phases. **Phases 1 and 2 are merged and complete** (accounts; profiles and
following). **Phase 3 is what you are finishing.** Later phases: 4 images, 5 memberships,
6 exclusive-content gating, 7 streaming re-pointed, 8 retire the old creator dashboard.

**All user-facing copy is Bahasa Indonesia.** This is not decoration — the audience is Indonesian
and phone-first.

Two source documents govern this phase and you should read both before writing code:

- Spec: `docs/superpowers/specs/2026-08-18-posts-and-feed-design.md` — what is being built and *why*,
  including everything deliberately excluded.
- Plan: `docs/superpowers/plans/2026-08-18-posts-and-feed.md` — eight tasks with the code to write.

The parent UI spec, `docs/superpowers/specs/2026-08-17-member-ui-design.md`, fixes decisions this
phase must not re-open.

---

## 2. Exactly where things stand

| Task | Commits | State |
|---|---|---|
| 1 — `post` table + repository | `265c499`, `0c69083` | complete, reviewed, fix round applied |
| 2 — use cases, shared limit, routes | `97e4d77`, `53fb863` | complete, reviewed, fix round applied |
| 3 — relative time + `PostCard` | `6bf02f2` | complete, **approved with no fix round** |
| 4 — `PostFeed` + keyset pagination | `3121443`, `8a5568f` | complete, reviewed, fix round applied |
| 5 — Beranda tabs, compose/edit/delete | `f8e7ad4`, `0592db2` | complete, reviewed, fix round applied |
| 6 — posts on the profile | `8749868` | **built, NEVER REVIEWED** |
| 7 — repair the split session | — | **not started** |
| 8 — the gate | — | **not started** |

**2781 pass / 0 fail** — shared 82, worker 38, web 625, api 2036. Typecheck clean in all four
workspaces.

Phase 3 was merged to `main` early and knowingly incomplete so the work could move machines. The
merge commit says so. **Nothing is deployed by a merge** — `scripts/deploy.sh` is manual — but
`/beranda` will show a real feed the moment someone deploys.

---

## 3. What to do, in order

### 3.1 Review Task 6 — do this before anything else

It is the only task in the phase with no review, and this project's reviews have found something
real in almost every task. Its report is `task-6-report.md` here.

Its implementer disclosed one deliberate gap, and **ruling on it is the first decision you owe**:
the **`Edit` button on your own posts on a profile renders but is unwired** — tapping it does
nothing. It argued the brief named only delete as needing to function. A visible control that does
nothing is arguably worse than no control; decide, and either wire it or remove it.

Its report also raises: `ownHandle` is read once per render rather than subscribed, so a session
expiring mid-visit can leave stale Edit/Hapus controls until an unrelated re-render. `BerandaPage`
solved the same problem with `useSyncExternalStore(subscribeToUserAuth, …)`.

### 3.2 Task 7 — repair the split session

Fully specified in the plan. In short: the token key and the account key in `localStorage` can
disagree, and in that state a live "Ikuti" button renders on your own profile. Repair it **at the
cause** — re-fetch `/users/me` and re-run `setUserSession` — not by patching the screens that render
wrongly. This requires dropping the unread `id` field from `SessionUser`, because `/users/me` has
never returned it.

### 3.3 Task 8 — the gate

**Nothing in this entire phase has been opened in a browser.** The gate is where that finally
happens, and on this project the gate has found something no unit test could every single time: the
previous phase's gate found six pages dead in the running app because of one missing Vite proxy
entry, and the one before found a whole feature unreachable from the UI. Treat it as a real task,
not a formality. Its checklist is in the plan.

### 3.4 Whole-branch review, then a fix round

Run it on the most capable model available. Point it at this directory's `progress.md` so it can
triage the parked findings in §6 below.

---

## 4. How this project is worked

Each task runs as: **fresh implementer → review → fix round → scoped re-review → next task.** The
implementer and the reviewer are different agents; the reviewer verifies the implementer's claims
rather than trusting them. Record every ruling in `progress.md` as you go — it is the only thing
that survives a context loss.

**Reviews here find results by mutating code and watching tests fail, not by reading.** This is the
single most important thing in this document. A green suite has repeatedly proved nothing on this
codebase. Found this way, on this branch alone:

- Two database indexes could be **deleted outright** from the migration with the whole API workspace
  green — 1970 pass, 0 fail.
- The post projection was pinned on **one of three** select sites; adding `authorId`, `deletedAt` and
  `email` to the other two changed nothing.
- Two documented guarantees of `PostFeedHandle` were each broken by a one-line change while all 618
  web tests passed, because every delete test used a **one-row fixture**.
- A route-mounting order shadowed two real routes — a user registering the handle `posts` got a
  permanently 404 profile and could be followed but never unfollowed — and swapping the two mount
  lines left the suite green.

Two failure modes recurred and are worth watching for in your own work:

- **A mutation that survives because the mutation was bad**, not because the test is vacuous. Anchor
  substitutions precisely.
- **An assertion that is unreachable** because an earlier assertion in the same test fails first.
  Task 4 shipped a URL check that never ran for a whole review cycle. One still-unreachable
  assertion is recorded in §6.

**If you write code before its test, say so in your report.** One implementer disclosed it had no red
phase, the review aimed its mutation budget there, and all three of its Important findings landed in
exactly that code.

---

## 5. Rules that are not negotiable

- **Gates are `bun run test` and `bun run typecheck` from the repo root. NEVER bare `bun test`** — it
  yields ~123 spurious failures, because `apps/web` needs its own `bunfig.toml` preload and Bun reads
  `bunfig.toml` from CWD only.
- **Migrations are Drizzle-generated only.** Edit `apps/api/src/db/schema.ts`, then
  `cd apps/api && bun run db:generate`. Never hand-write or edit a file in `apps/api/drizzle/`, and
  commit `drizzle/meta/` alongside the `.sql`. Note the test database migrates from the **SQL files**,
  not from `schema.ts` — mutating `schema.ts` alone proves nothing about the database.
- **Never touch `apps/web/src/dashboard/`.** The old creator dashboard runs untouched until Phase 8
  deletes it. Restyling a surface scheduled for deletion is the clearest waste available.
- **The post projection over the wire is exactly** `id`, `body`, `createdAt`, `editedAt`,
  `author: { handle, displayName }`. No `authorId`, no `deletedAt`, no email, no user id. **Assert on
  response keys, never on TypeScript types** — a bare `select()` returns every column whatever the
  types claim.
- **Error text on screen comes from `describeRequestFailure`**, never from a server message.
  `apps/web/src/test/no-raw-server-errors.test.ts` is a source scan over everything in `src/user/`.
  Failure paragraphs carry `role="alert"`; non-urgent notices use `role="status"`.
- **Every endpoint lives under the `/users/` prefix.** A new top-level prefix needs a `vite.config.ts`
  proxy entry, and that exact gap has broken this app three times.
- `expect(<DOM element>).toBeNull()` **hangs `bun test`**. Use `expect(x === null).toBe(true)`.
- **`PostCard`'s delete callback is `onDeleteRequested`, and it fires on the TAP**, before anything is
  deleted. The consumer owns the confirmation and the `deletePost` call. It was renamed from
  `onDeleted` for exactly this reason.

---

## 6. Parked findings — deliberately not fixed

Triage these in the whole-branch review; do not silently discard them.

- **No reserved-handle list.** `domain/handle.ts` is `/^[a-z0-9_]{3,30}$/`, so `posts`, `feed`, `me`
  are all registrable. With the mount order corrected nothing breaks today, so this is a latent
  hazard rather than a defect. It needs a product decision — existing accounts may already hold such
  handles. `app.ts` records the same gap for community slugs.
- **`BerandaPage.test.tsx:456`'s final assertion is unreachable** — the confirmation panel's
  visibility and `pendingDelete` share one conditional, so any mutation leaving the state set trips
  an earlier assertion first. It documents intent but is not load-bearing.
- **Tapping Hapus then Edit renders both panels at once.** Neither handler clears the other's state.
- **A create racing the first page load can drop the new post from view** (the post is saved).
  Measured, judged not worth a queue.
- **A 401 on Mengikuti now shows `Masuk untuk melihat` rather than `Sesi Anda sudah berakhir`** — more
  actionable, less explanatory. An accepted trade; carrying both would need a "was signed in a moment
  ago" state.
- **One soft-delete test covers three paths sequentially**, so the first failure short-circuits and
  one run can never reveal more than one broken path. Each path is individually detected.

---

## 7. What has never been verified

- **Anything in a browser.** No screen in this phase has been rendered outside happy-dom. The CSS
  additions are unexercised at every viewport.
- `vite build` has not been run on this branch; nginx has not been touched. Every new endpoint sits
  under the `/users/` prefix that production already proxies, so **no new server work is expected** —
  but that is reasoning from the route table, not a measurement.
- **The app has never been deployed with any of this.** Production is several phases behind: as of
  this writing `diudara.mhamzah.id` does not even have Phase 1's or Phase 2's code, so `/jelajah` and
  `/beranda` 404 there.
- `EXPLAIN` has been run for the two `post` indexes, but not at production data shape.

---

## 8. Environment on a new machine

- `bun install` at the repo root.
- Postgres reachable, and **`apps/api/.env` present — it is gitignored and does not travel with the
  repo.** Copy it across or recreate it. A half-configured provider pair (e.g. `RESEND_API_KEY`
  without `EMAIL_FROM`) throws at boot in every environment.
- `cd apps/api && bun run db:migrate` if the database is fresh. Newest migration is
  `0022_violet_lila_cheney.sql`, which creates the `post` table.

**Two things that will waste hours if you do not know them:**

**The `apps/api` flake family.** About a dozen tests fail under CPU contention — all of them compare
a Bun-side clock against Postgres's `now()`, and they clear on a re-run. They are **`apps/api` only**,
so a failure in `apps/web` is real until proven otherwise. Names include `GrantChannelAccess`,
`ProcessRenewals`, `markPaid`, `markPastDue`, `touchProcessing`. Running several test processes at
once reproduces them on demand. **Capture any `(fail)` line verbatim before re-running, and never
pipe the capture through `tail`** — sightings have been lost that way four times here.

**Orphaned test processes.** Task 6's implementer saw **197 failures** across files it had never
touched, including `dashboard/` files, and root-caused it to a stray two-hour-old `bun test` process
from an earlier session contending for CPU. If a run looks catastrophically broken, check for stray
processes before believing it.
