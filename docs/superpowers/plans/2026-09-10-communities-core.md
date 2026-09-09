# Communities Core (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user can create a community, find one, join it, and see who else is in it.

**Architecture:** Drop the eighteen dormant tables of the retired community-centric model, then build two fresh tables owned by `app_user`. The API follows this repo's hexagonal slice exactly — route → use-case → port interface → Drizzle repository, hand-wired in `bootstrap()`. The web app gains a two-tab browse page, a community home, and a create form.

**Tech Stack:** Bun, Hono, Drizzle ORM on Postgres, React 19 + Vite 5 + react-router-dom 7, `bun test` with `@happy-dom/global-registrator` and `@testing-library/react`. Zod for wire schemas in `packages/shared`.

**Spec:** `docs/superpowers/specs/2026-09-09-communities-core-design.md`
**Programme:** `docs/superpowers/specs/2026-09-09-udara-program-design.md`

## Global Constraints

- **All UI copy in Bahasa Indonesia.** Binding project rule.
- **Failure copy comes from `errorCopy.ts`**, derived from the error's *shape*, never from a server message. Guarded by `apps/web/src/test/no-raw-server-errors.test.ts`.
- **`styles.css` is imported ONLY from `src/main.tsx`.** `bun test` has no CSS loader.
- **Never assert a DOM element against `toBeNull`/`toBeUndefined`/`toBe(null)`** — assert `.length` counts. Guarded by `no-hanging-dom-assertions.test.ts`; a failing one once produced a 178-second, 335 MB failure.
- **No `toBeInTheDocument`** — `@testing-library/jest-dom` is not installed. Use `toBeTruthy()` and `.length`.
- **No colour literal outside `:root`** in `styles.css`; `@keyframes` steps and `color-mix(...)` are exempt. Guarded.
- **Every `var(--x)` must name a declared property.** Guarded by `no-dangling-tokens.test.ts`.
- **Every rule declaring both a `color` and a `background` must clear 4.5:1.** Guarded by `contrast.test.ts`. The established remedy is to change the ink, never the hue: `--ink-900` on a mid-tone fill, or `--success-ink` / `--warning-ink` / `--danger-ink` on a tinted one.
- **The Udara `.btn*` block must stay declared after the legacy `.button-*` rules.** Guarded by `cascade-order.test.ts`.
- **Navigation z-index invariant:** `.bottom-nav` and `.side-rail` at 10, everything else below. Guarded by `AppShell.test.tsx`.
- **These six class names are asserted by tests:** `.post-card-body`, `.post-card-media`, `.post-card-locked-count`, `.post-card-meta`, `.membership-offer`, `.profile-bio`.
- **Never hand-write migration SQL** and never edit an applied migration. `bun run db:generate` from `apps/api`, then read the generated file before committing.
- **New tables go into `resetDatabase()` in FK order**, children before parents, each with a comment saying why it sits where it does — every existing entry has one.
- **TypeScript `strict: true`.** No linter, no formatter in this repo.
- **No dev servers, no Playwright, no browser gates.** Verification is `bun test` and `bun run typecheck`.
- **There is no CI test gate** — a push to `main` deploys. Green before commit is a real obligation.
- Run API commands from `apps/api` and web commands from `apps/web`. `bunfig.toml` is read from the CWD and is not searched for upward.

**The six categories, exact strings:** `Bimbel & Ujian`, `Coaching Bisnis`, `Kajian & Rohani`, `Edukasi Finansial`, `Skill Digital`, `Kreator & Media`.

---

## File structure

**Deleted (Task 1):** eighteen table definitions in `apps/api/src/db/schema.ts`; their `db.delete(...)` lines in `src/db/test-helpers.ts`; the `schema-*.test.ts` files that exist only to exercise them; four `UniqueRule` entries in `src/application/errors.ts`.

**Created:**

| File | Responsibility |
|---|---|
| `packages/shared/src/community.schema.ts` | Categories, length limits, create-payload schema |
| `apps/api/src/domain/community-slug.ts` | Slugify, validate, reserved slugs — pure, no I/O |
| `apps/api/src/application/ports/community-repository.port.ts` | The interface and its row types |
| `apps/api/src/infrastructure/repositories/drizzle-community.repository.ts` | Drizzle implementation |
| `apps/api/src/application/use-cases/create-community.ts` | Create + owner membership, one transaction |
| `apps/api/src/application/use-cases/get-community.ts` | One community + viewer state |
| `apps/api/src/application/use-cases/join-community.ts` | Join and leave |
| `apps/api/src/application/use-cases/browse-communities.ts` | Search, category filter, paging |
| `apps/api/src/application/use-cases/list-community-members.ts` | The roster |
| `apps/api/src/routes/communities.ts` | The router |
| `apps/web/src/user/communityColor.ts` | Slug → palette hue, pure |
| `apps/web/src/user/CommunityCard.tsx` | One card in the browse grid |
| `apps/web/src/user/CommunityPage.tsx` | `/komunitas/:slug` — banner, join, roster |
| `apps/web/src/user/CommunityCreatePage.tsx` | `/komunitas/baru` |

**Modified:** `apps/api/src/db/schema.ts`, `test-helpers.ts`, `bootstrap.ts`, `app.ts`; `packages/shared/src/index.ts`; `apps/web/src/user/apiClient.ts`, `errorCopy.ts`, `JelajahPage.tsx`, `App.tsx`; `apps/web/vite.config.ts`; `apps/web/src/styles.css`.

---

### Task 1: Drop the dormant model

**Files:**
- Modify: `apps/api/src/db/schema.ts` (remove eighteen table definitions)
- Modify: `apps/api/src/db/test-helpers.ts` (remove their `db.delete` lines)
- Modify: `apps/api/src/application/errors.ts` (remove four orphaned `UniqueRule` entries)
- Delete: the `apps/api/src/db/schema-*.test.ts` files that exercise only dropped tables
- Create: one generated migration in `apps/api/drizzle/`

**Interfaces:**
- Consumes: nothing.
- Produces: a schema file containing only the live user-centric model, and a `resetDatabase()` with no dead entries. Task 2 adds to both.

- [ ] **Step 1: Establish the baseline**

Run, from `apps/api`: `bun test 2>&1 | tail -5`
Record the pass count. Then from `apps/web`: `bun test 2>&1 | tail -5` — expect 732 pass / 0 fail.

- [ ] **Step 2: Identify exactly which test files die with the tables**

Run: `grep -ln "creators\|communities\|membershipTiers\|channels\|channelMemberships\|members\b\|subscriptions\b\|renewalReminders\|joinRequests\|transactions\b\|activityLogs\|events\b\|eventRsvps\|courses\|enrollments\|aiConversations\|aiMessages\|aiUsage" src/db/*.test.ts`

For each file the command names, open it and decide: does it test **only** dropped tables (delete the file), or does it test a mix (delete only the dropped-table cases)? Record the decision per file in your report. Do not delete a file that also covers `app_user`, `post`, `follow`, `user_tier`, `user_subscription`, `user_stream`, `webhook_event` or `outbox`.

- [ ] **Step 3: Remove the table definitions**

In `apps/api/src/db/schema.ts`, delete the definitions for: `creators`, `communities`, `membershipTiers`, `channels`, `channelMemberships`, `members`, `subscriptions`, `renewalReminders`, `joinRequests`, `transactions`, `activityLogs`, `events`, `eventRsvps`, `courses`, `enrollments`, `aiConversations`, `aiMessages`, `aiUsage`.

Keep everything else: `appUsers`, `passwordResetTokens`, `signupNotices`, `follows`, `posts`, `postMedia`, `userTiers`, `userSubscriptions`, `userTransactions`, `membershipReminders`, `userStreams`, `webhookEvents`, `outbox`.

Add a short comment at the top of the file recording that the community-centric model was dropped in Phase 1 and why — a reader who finds this repo's history will otherwise wonder where `creator` went.

- [ ] **Step 4: Clean `resetDatabase()`**

In `apps/api/src/db/test-helpers.ts`, remove the `db.delete(...)` line and any explanatory comment for each dropped table, and remove them from the import. `webhookEvents` and `outbox` stay — neither has a foreign key, so their positions are free.

The function should end up deleting only: `webhookEvents`, `outbox`, `passwordResetTokens`, `signupNotices`, `follows`, `postMedia`, `posts`, `userTransactions`, `membershipReminders`, `userSubscriptions`, `userTiers`, `userStreams`, `appUsers` — in that order.

- [ ] **Step 5: Remove the orphaned uniqueness rules**

In `apps/api/src/application/errors.ts`, remove the `UniqueRule` entries `creatorEmail`, `communitySlug`, `channelPlatformGroup` and `subscriptionMemberTierActive`. Nothing can raise them once the constraints are gone.

If `communitySlug` is removed here, note in your report that Task 2 will need a rule for the NEW community slug constraint — it is not the same rule, and re-adding it under the same name would be misleading if the constraint name differs.

- [ ] **Step 6: Delete the dead test files**

Delete the files Step 2 identified as testing only dropped tables. For a mixed file, delete only the affected `describe`/`it` blocks.

- [ ] **Step 7: Generate the migration**

Run, from `apps/api`: `bun run db:generate`

Then **read the generated SQL**. It should be a sequence of `DROP TABLE` statements in dependency order — children before parents. Confirm it drops exactly eighteen tables and creates nothing. If it drops a table not on the list, stop and report.

- [ ] **Step 8: Verify**

From `apps/api`: `bun test` and `bun run typecheck`.
Expected: green. The per-run test database migrates from `drizzle/` on every run, so the drops are exercised automatically.

From `apps/web`: `bun test` and `bun run typecheck`.
Expected: 732 pass / 0 fail — the web app never referenced any of these tables.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/db apps/api/src/application/errors.ts apps/api/drizzle
git commit -m "feat!: drop the retired community-centric model

Eighteen tables with no live reader: the fifteen community-centric ones
from creator down through enrollment, plus the three creator-scoped ai_*
tables. The only non-test importer of any of them was test-helpers.ts,
which truncated them; four earlier commits had already deleted every
route, use-case, port and repository above them.

They cannot be revived in place. community.creator_id is NOT NULL
REFERENCES creator(id), and creator is a separate identity from app_user
with no foreign key and no login path since c8c5046 removed it. Phase 1
needs communities owned by app_users, so the dormant set goes and fresh
tables replace it.

This also retires the 0003 hazard permanently: that migration adds
community.slug as NOT NULL with no default and no backfill, fails on any
non-empty table, and could not be fixed by a later migration because
migrations run in order and an applied one must not be edited.

The repo owner authorised the data loss explicitly, having been told it
covers transaction, subscription, member and creator rows."
```

---

### Task 2: The new schema and the shared wire contract

**Files:**
- Create: `packages/shared/src/community.schema.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/src/db/schema.ts` (add two tables)
- Modify: `apps/api/src/db/test-helpers.ts` (add two deletes, in FK order)
- Create: `packages/shared/src/community.schema.test.ts`
- Create: one generated migration

**Interfaces:**
- Consumes: Task 1's cleaned schema.
- Produces: `COMMUNITY_CATEGORIES` (readonly tuple of six), `CommunityCategory`, `MAX_COMMUNITY_NAME_LENGTH` (120), `MAX_COMMUNITY_DESCRIPTION_LENGTH` (300), `MAX_COMMUNITY_SEARCH_LENGTH` (100), `DEFAULT_COMMUNITY_LIST_LIMIT` (24), `DEFAULT_COMMUNITY_MEMBER_LIMIT` (50), `createCommunitySchema`. Drizzle tables `communities` and `communityMembers`. Tasks 3–9 all consume these.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/community.schema.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  COMMUNITY_CATEGORIES,
  MAX_COMMUNITY_DESCRIPTION_LENGTH,
  MAX_COMMUNITY_NAME_LENGTH,
  createCommunitySchema,
} from "./community.schema";

describe("createCommunitySchema", () => {
  it("accepts a minimal valid payload", () => {
    const parsed = createCommunitySchema.parse({
      name: "Bimbel Matematika Pak Andi",
      category: "Bimbel & Ujian",
    });
    expect(parsed.name).toBe("Bimbel Matematika Pak Andi");
    expect(parsed.description).toBe(undefined);
  });

  it("trims the name, so a padded submission cannot smuggle whitespace into a slug", () => {
    const parsed = createCommunitySchema.parse({
      name: "   Kelas Desain   ",
      category: "Skill Digital",
    });
    expect(parsed.name).toBe("Kelas Desain");
  });

  it("rejects a category outside the six", () => {
    const result = createCommunitySchema.safeParse({
      name: "Kelas Desain",
      category: "Olahraga",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a name past the column's length, rather than letting Postgres truncate or error", () => {
    const result = createCommunitySchema.safeParse({
      name: "a".repeat(MAX_COMMUNITY_NAME_LENGTH + 1),
      category: "Skill Digital",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a description past the column's length", () => {
    const result = createCommunitySchema.safeParse({
      name: "Kelas Desain",
      category: "Skill Digital",
      description: "a".repeat(MAX_COMMUNITY_DESCRIPTION_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it("names exactly the six categories the reference defines, in order", () => {
    expect(COMMUNITY_CATEGORIES.join(" | ")).toBe(
      "Bimbel & Ujian | Coaching Bisnis | Kajian & Rohani | Edukasi Finansial | Skill Digital | Kreator & Media"
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

From `packages/shared`: `bun test src/community.schema.test.ts`
Expected: FAIL — `Cannot find module './community.schema'`.

- [ ] **Step 3: Write the schema**

Create `packages/shared/src/community.schema.ts`:

```ts
import { z } from "zod";

/**
 * The six categories the design reference defines, and the only values a
 * community may carry. Exact strings, including the ampersands and the
 * Indonesian spelling — the browse page's category chips render these
 * verbatim, so a change here is a change to the UI.
 */
export const COMMUNITY_CATEGORIES = [
  "Bimbel & Ujian",
  "Coaching Bisnis",
  "Kajian & Rohani",
  "Edukasi Finansial",
  "Skill Digital",
  "Kreator & Media",
] as const;

export type CommunityCategory = (typeof COMMUNITY_CATEGORIES)[number];

/** Matches `community.name`'s column width. */
export const MAX_COMMUNITY_NAME_LENGTH = 120;
/** Matches `community.description`'s column width, and `app_user.bio`'s. */
export const MAX_COMMUNITY_DESCRIPTION_LENGTH = 300;
/** Same clamp as the people search, and for the same reason: the query groups over a table. */
export const MAX_COMMUNITY_SEARCH_LENGTH = 100;
/** One screen of cards. */
export const DEFAULT_COMMUNITY_LIST_LIMIT = 24;
/** The same cap the follow lists use, so a roster truncates the way a follower list does. */
export const DEFAULT_COMMUNITY_MEMBER_LIMIT = 50;

/**
 * The create payload. `name` is trimmed before length-checking so a padded
 * submission cannot slug differently from what the user sees, and the maxima
 * mirror the columns exactly — a payload that passes here can always be stored.
 */
export const createCommunitySchema = z.object({
  name: z.string().trim().min(3).max(MAX_COMMUNITY_NAME_LENGTH),
  category: z.enum(COMMUNITY_CATEGORIES),
  description: z.string().trim().max(MAX_COMMUNITY_DESCRIPTION_LENGTH).optional(),
});

export type CreateCommunityInput = z.infer<typeof createCommunitySchema>;
```

Add to `packages/shared/src/index.ts`:

```ts
export * from "./community.schema";
```

- [ ] **Step 4: Run the test**

From `packages/shared`: `bun test src/community.schema.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Add the tables**

In `apps/api/src/db/schema.ts`, after the user-centric tables:

```ts
/**
 * A community owned by an `app_user`.
 *
 * This is NOT the `community` table that was dropped in Phase 1. That one hung
 * off `creator`, a separate identity with no relationship to `app_user` and no
 * login path since its routes were deleted. The name is reused because the
 * table it named is gone and the product's central concept should have it.
 */
export const communities = pgTable(
  "community",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => appUsers.id),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 60 }).notNull().unique(),
    category: varchar("category", { length: 64 }).notNull(),
    description: varchar("description", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("community_owner_idx").on(table.ownerId),
    // The browse page's default listing is "newest in this category", and its
    // unfiltered listing is "newest overall" — the leading column is skipped
    // for the second, which Postgres allows at a cost this table's size makes
    // irrelevant.
    index("community_category_created_idx").on(table.category, table.createdAt),
  ],
);

/**
 * Membership. One row per person per community, including the owner — a
 * community with no members is not a state this app can reach, because
 * `CreateCommunity` writes both rows in one transaction.
 */
export const communityMembers = pgTable(
  "community_member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id),
    role: varchar("role", { length: 16 }).notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Joining is idempotent through this: the repository uses
    // onConflictDoNothing on these two columns rather than catching a 23505.
    uniqueIndex("community_member_unique").on(table.communityId, table.userId),
    // "which communities am I in" — the sidebar and the browse page's
    // viewer-is-member marking both read this way.
    index("community_member_user_idx").on(table.userId),
    index("community_member_community_joined_idx").on(table.communityId, table.joinedAt),
  ],
);
```

- [ ] **Step 6: Add them to `resetDatabase()`**

In `apps/api/src/db/test-helpers.ts`, import both and add, keeping the file's convention of a comment explaining each position:

```ts
  // communityMembers references community and app_user, so it must clear
  // before both — Phase 1, same FK-ordering rule as every entry above.
  await db.delete(communityMembers);
  // community references app_user (owner), so it must clear before app_user.
  await db.delete(communities);
```

Place them **before** `await db.delete(appUsers);`. `appUsers` must remain last.

- [ ] **Step 7: Generate and read the migration**

From `apps/api`: `bun run db:generate`

Read the generated SQL. Expect one `CREATE TABLE` per table, the two foreign keys, the unique on `slug`, and the three indexes plus `community_member_unique`. It must create only these two tables.

- [ ] **Step 8: Verify**

From `apps/api`: `bun test` and `bun run typecheck` — green.
From `packages/shared`: `bun test` and `bun run typecheck` — green.

- [ ] **Step 9: Commit**

```bash
git add packages/shared apps/api/src/db apps/api/drizzle
git commit -m "feat: add community and community_member, owned by app_user

Two tables and the wire contract for them. The name `community` is reused
deliberately: the table that held it was dropped in Task 1, and the
product's central concept should have the good name rather than a
second-class one.

Three absences are deliberate. No color column — the reference gives each
community a palette hue for its card, and deriving it from the slug is
deterministic, needs no picker in the create form and cannot drift
off-palette. No denormalised member count — count(*) is correct and this
product has no communities yet. No access_mode — the old table had
paid|request, this phase has one join model, and a column with one legal
value lies about its future.

The six categories live in packages/shared because both the API's
validation and the browse page's chips must agree on the exact strings."
```

---

### Task 3: The slug domain, the port, and the repository

**Files:**
- Create: `apps/api/src/domain/community-slug.ts`
- Create: `apps/api/src/domain/community-slug.test.ts`
- Create: `apps/api/src/application/ports/community-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-community.repository.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-community.repository.test.ts`

**Interfaces:**
- Consumes: `communities`, `communityMembers` from Task 2.
- Produces:
  - `slugifyCommunityName(name: string): string`, `isValidCommunitySlug(s: string): boolean`, `isReservedCommunitySlug(s: string): boolean`
  - `CommunityRecord = { id, ownerId, slug, name, category, description: string | null, createdAt: Date }`
  - `CommunityListRow = { slug, name, category, description: string | null, memberCount: number }`
  - `CommunityMemberRow = { handle, displayName, bio: string | null, role: string, joinedAt: Date }`
  - `CommunityRepositoryPort` with `create`, `findBySlug`, `browse`, `memberCountFor`, `isMember`, `join`, `leave`, `listMembers`
  - `DrizzleCommunityRepository`
  Tasks 4–6 consume the port; Task 7 wires the repository.

- [ ] **Step 1: Write the failing slug test**

Create `apps/api/src/domain/community-slug.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  isReservedCommunitySlug,
  isValidCommunitySlug,
  slugifyCommunityName,
} from "./community-slug";

describe("slugifyCommunityName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyCommunityName("Bimbel Matematika Pak Andi")).toBe("bimbel-matematika-pak-andi");
  });

  it("collapses runs of punctuation and whitespace into one hyphen", () => {
    expect(slugifyCommunityName("Kajian  &  Rohani!!")).toBe("kajian-rohani");
  });

  it("strips leading and trailing hyphens, so a name that starts with punctuation is still valid", () => {
    expect(slugifyCommunityName("  ***Kelas Desain***  ")).toBe("kelas-desain");
  });

  it("never ends in a hyphen after truncation", () => {
    // 60 chars is the column width; the cut must not leave a dangling separator.
    const long = `${"a".repeat(59)} tail`;
    const slug = slugifyCommunityName(long);
    expect(slug.length <= 60).toBe(true);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("returns an empty string when a name has nothing sluggable, rather than inventing one", () => {
    expect(slugifyCommunityName("!!! ???")).toBe("");
  });
});

describe("isValidCommunitySlug", () => {
  it("accepts lowercase, digits and hyphens between 3 and 60 characters", () => {
    expect(isValidCommunitySlug("bimbel-sbmptn")).toBe(true);
    expect(isValidCommunitySlug("abc")).toBe(true);
  });

  it("rejects the shapes that would break a URL or a column", () => {
    expect(isValidCommunitySlug("ab")).toBe(false);
    expect(isValidCommunitySlug("a".repeat(61))).toBe(false);
    expect(isValidCommunitySlug("Kelas")).toBe(false);
    expect(isValidCommunitySlug("kelas desain")).toBe(false);
  });
});

describe("isReservedCommunitySlug", () => {
  /**
   * `/komunitas/baru` is the create form, so a community slugged `baru` would
   * be permanently unreachable. `pengikut` and `mengikuti` are the second
   * segments of the existing `/:handleParam/pengikut` and `/mengikuti` routes:
   * react-router scores `/komunitas/:slug` and `/:handleParam/pengikut`
   * identically for the URL `/komunitas/pengikut` — one static segment and one
   * dynamic each — so which wins is decided by declaration order rather than
   * by intent. Reserving is cheaper than depending on that.
   */
  it("reserves the slugs that would collide with a real route", () => {
    expect(isReservedCommunitySlug("baru")).toBe(true);
    expect(isReservedCommunitySlug("pengikut")).toBe(true);
    expect(isReservedCommunitySlug("mengikuti")).toBe(true);
  });

  it("does not reserve an ordinary slug", () => {
    expect(isReservedCommunitySlug("bimbel-sbmptn")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

From `apps/api`: `bun test src/domain/community-slug.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the slug domain**

Create `apps/api/src/domain/community-slug.ts`:

```ts
/** 3-60 chars, lowercase letters, digits and hyphens — the column is varchar(60). */
export const COMMUNITY_SLUG_PATTERN = /^[a-z0-9-]{3,60}$/;

const MAX_SLUG_LENGTH = 60;

/**
 * Derive a URL slug from a community's name.
 *
 * Returns an empty string when the name contains nothing sluggable, rather
 * than inventing a placeholder: the caller decides what to tell the user, and
 * a generated slug the user never chose is worse than a clear rejection.
 */
export function slugifyCommunityName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

export function isValidCommunitySlug(slug: string): boolean {
  return COMMUNITY_SLUG_PATTERN.test(slug);
}

/**
 * Slugs nobody may take, because each is a literal segment of a real web
 * route and a community holding it would be unreachable.
 *
 * `baru` is `/komunitas/baru`, the create form. `pengikut` and `mengikuti`
 * are the second segments of `/:handleParam/pengikut` and `/:handleParam/mengikuti`:
 * for the URL `/komunitas/pengikut`, react-router scores that route and
 * `/komunitas/:slug` identically — one static segment and one dynamic each —
 * so the winner is decided by declaration order rather than by intent.
 */
export const RESERVED_COMMUNITY_SLUGS: ReadonlySet<string> = new Set([
  "baru",
  "mengikuti",
  "pengikut",
]);

export function isReservedCommunitySlug(slug: string): boolean {
  return RESERVED_COMMUNITY_SLUGS.has(slug);
}
```

- [ ] **Step 4: Run the slug test**

From `apps/api`: `bun test src/domain/community-slug.test.ts`
Expected: PASS, all nine.

- [ ] **Step 5: Write the port**

Create `apps/api/src/application/ports/community-repository.port.ts`:

```ts
export interface CommunityRecord {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  category: string;
  description: string | null;
  createdAt: Date;
}

/** One card in the browse grid. `memberCount` is computed, not stored. */
export interface CommunityListRow {
  slug: string;
  name: string;
  category: string;
  description: string | null;
  memberCount: number;
}

export interface CommunityMemberRow {
  handle: string;
  displayName: string;
  bio: string | null;
  role: string;
  joinedAt: Date;
}

export interface BrowseCommunitiesQuery {
  /** Already trimmed and clamped by the use-case. Empty means "no search". */
  search: string;
  /** Empty means "every category". */
  category: string;
  limit: number;
}

export interface CommunityRepositoryPort {
  /**
   * Writes the community AND the owner's `community_member` row in one
   * transaction. A community with no members is not a reachable state.
   * Throws the repository's translated uniqueness error if the slug is taken.
   */
  create(input: {
    ownerId: string;
    slug: string;
    name: string;
    category: string;
    description: string | null;
  }): Promise<CommunityRecord>;

  findBySlug(slug: string): Promise<CommunityRecord | null>;

  browse(query: BrowseCommunitiesQuery): Promise<CommunityListRow[]>;

  memberCountFor(communityId: string): Promise<number>;

  isMember(communityId: string, userId: string): Promise<boolean>;

  /** Idempotent: `false` when the row already existed, `true` when created. */
  join(communityId: string, userId: string): Promise<boolean>;

  /** Idempotent: `false` when there was nothing to remove. */
  leave(communityId: string, userId: string): Promise<boolean>;

  /** Owner first, then newest joiners. The caller clamps `limit`. */
  listMembers(communityId: string, limit: number): Promise<CommunityMemberRow[]>;
}
```

- [ ] **Step 6: Write the failing repository test**

Create `apps/api/src/infrastructure/repositories/drizzle-community.repository.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleCommunityRepository } from "./drizzle-community.repository";

beforeEach(resetDatabase);

async function seedUser(handle: string): Promise<string> {
  const [row] = await db
    .insert(appUsers)
    .values({
      handle,
      email: `${handle}@example.com`,
      passwordHash: "hash",
      displayName: handle,
    })
    .returning({ id: appUsers.id });
  return row!.id;
}

function repo() {
  return new DrizzleCommunityRepository(db);
}

describe("DrizzleCommunityRepository", () => {
  it("creating a community also makes the owner a member, in one transaction", async () => {
    const ownerId = await seedUser("wildan");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    expect(created.slug).toBe("kelas-desain");
    expect(await repo().memberCountFor(created.id)).toBe(1);
    expect(await repo().isMember(created.id, ownerId)).toBe(true);
  });

  it("the owner's membership row carries the owner role", async () => {
    const ownerId = await seedUser("wildan");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    const members = await repo().listMembers(created.id, 50);
    expect(members.map((m) => `${m.handle}:${m.role}`).join(",")).toBe("wildan:owner");
  });

  it("joining twice writes one row and reports the second as already present", async () => {
    const ownerId = await seedUser("wildan");
    const joinerId = await seedUser("rina");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    expect(await repo().join(created.id, joinerId)).toBe(true);
    expect(await repo().join(created.id, joinerId)).toBe(false);
    expect(await repo().memberCountFor(created.id)).toBe(2);
  });

  it("leaving is idempotent and reports whether anything was removed", async () => {
    const ownerId = await seedUser("wildan");
    const joinerId = await seedUser("rina");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });
    await repo().join(created.id, joinerId);

    expect(await repo().leave(created.id, joinerId)).toBe(true);
    expect(await repo().leave(created.id, joinerId)).toBe(false);
    expect(await repo().memberCountFor(created.id)).toBe(1);
  });

  it("browse filters by category and by a case-insensitive name match", async () => {
    const ownerId = await seedUser("wildan");
    await repo().create({ ownerId, slug: "kelas-desain", name: "Kelas Desain", category: "Skill Digital", description: null });
    await repo().create({ ownerId, slug: "bimbel-sbmptn", name: "Bimbel SBMPTN", category: "Bimbel & Ujian", description: null });

    const byCategory = await repo().browse({ search: "", category: "Skill Digital", limit: 24 });
    expect(byCategory.map((c) => c.slug).join(",")).toBe("kelas-desain");

    const bySearch = await repo().browse({ search: "bimbel", category: "", limit: 24 });
    expect(bySearch.map((c) => c.slug).join(",")).toBe("bimbel-sbmptn");

    const all = await repo().browse({ search: "", category: "", limit: 24 });
    expect(all.length).toBe(2);
  });

  it("browse reports a member count per row, so the grid needs no second query", async () => {
    const ownerId = await seedUser("wildan");
    const joinerId = await seedUser("rina");
    const created = await repo().create({ ownerId, slug: "kelas-desain", name: "Kelas Desain", category: "Skill Digital", description: null });
    await repo().join(created.id, joinerId);

    const rows = await repo().browse({ search: "", category: "", limit: 24 });
    expect(rows.map((r) => `${r.slug}:${r.memberCount}`).join(",")).toBe("kelas-desain:2");
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

From `apps/api`: `bun test src/infrastructure/repositories/drizzle-community.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Write the repository**

Create `apps/api/src/infrastructure/repositories/drizzle-community.repository.ts`. Follow `drizzle-follow.repository.ts` for shape: a `DatabaseExecutor` in the constructor, explicit column projections, `onConflictDoNothing` rather than catching `23505`, and a clamped limit.

Requirements the tests pin:
- `create` runs `this.db.transaction(...)`, inserting the community then the owner's `community_member` row with `role: "owner"`.
- `browse` left-joins a member-count aggregate so one query fills the grid; it filters on `category` when non-empty and on a case-insensitive `name` match when `search` is non-empty; it orders newest first.
- `join` uses `.onConflictDoNothing({ target: [communityMembers.communityId, communityMembers.userId] })` and returns whether a row came back.
- `listMembers` orders the owner first, then by `joinedAt`, and clamps `limit`.

Translate the slug uniqueness violation into the application's vocabulary the way the other repositories do — see how `drizzle-user.repository.ts` maps `app_user_handle_unique`.

- [ ] **Step 9: Run the repository test**

From `apps/api`: `bun test src/infrastructure/repositories/drizzle-community.repository.test.ts`
Expected: PASS, all six.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/domain/community-slug.ts apps/api/src/domain/community-slug.test.ts apps/api/src/application/ports/community-repository.port.ts apps/api/src/infrastructure/repositories/drizzle-community.repository.ts apps/api/src/infrastructure/repositories/drizzle-community.repository.test.ts
git commit -m "feat: community slug domain, repository port and Drizzle adapter

slugifyCommunityName returns an empty string for a name with nothing
sluggable rather than inventing a placeholder — the caller decides what to
tell the user, and a slug nobody chose is worse than a clear rejection.

Three slugs are reserved. baru is /komunitas/baru, the create form.
pengikut and mengikuti are the second segments of the existing
/:handleParam routes: for /komunitas/pengikut, react-router scores
/komunitas/:slug and /:handleParam/pengikut identically — one static
segment and one dynamic each — so declaration order rather than intent
would decide the winner.

create writes the community and the owner's membership in one
transaction; a community with no members is not a reachable state."
```

---

### Task 4: Create, read and join use-cases

**Files:**
- Create: `apps/api/src/application/use-cases/create-community.ts` + `.test.ts`
- Create: `apps/api/src/application/use-cases/get-community.ts` + `.test.ts`
- Create: `apps/api/src/application/use-cases/join-community.ts` + `.test.ts`

**Interfaces:**
- Consumes: `CommunityRepositoryPort`, `UserRepositoryPort`, and the slug domain from Task 3; `createCommunitySchema` from Task 2.
- Produces:
  - `CreateCommunity` — `execute({ ownerId, name, category, description })` → `CommunityDetail`
  - `GetCommunity` — `execute({ slug, viewerId: string | null })` → `CommunityDetail`
  - `JoinCommunity` — `execute({ userId, slug, action: "join" | "leave" })` → `{ member: boolean }`
  - `CommunityDetail = { slug, name, category, description: string | null, memberCount, ownerHandle, ownerDisplayName, viewerIsMember: boolean | null, viewerIsOwner: boolean, createdAt: Date }`
  Task 6 renders these; Task 7 routes them.

- [ ] **Step 1: Write the failing tests**

Create the three `.test.ts` files. Follow `follow-user.test.ts` exactly for fake style: a `fakeUserRepository(rows)` whose unimplemented methods `throw new Error("not used in these tests")`, and a `FakeCommunityRepository` class that counts calls so a test can assert a port was **never reached**.

The behaviours to pin, one `it` each:

*CreateCommunity*
- a valid name produces the expected slug and returns the detail
- the owner is a member of their own community on creation (`viewerIsOwner` true, `memberCount` 1)
- a name with nothing sluggable is a `ValidationError` and **never reaches the repository** (assert the create call count is 0)
- a reserved slug is a `ConflictError` and never reaches the repository
- a taken slug surfaces as a `ConflictError` naming the slug

*GetCommunity*
- an unknown slug is a `NotFoundError`
- a signed-out viewer gets `viewerIsMember: null`, not `false` — the two mean different things to the join button
- a signed-in non-member gets `viewerIsMember: false`
- the owner gets `viewerIsOwner: true`

*JoinCommunity*
- joining returns `{ member: true }`; joining again returns `{ member: true }` and writes no second row
- leaving returns `{ member: false }`; leaving again returns `{ member: false }`
- **the owner cannot leave their own community** — `ConflictError`, and the repository is never reached
- an unknown slug is a `NotFoundError`

- [ ] **Step 2: Run them to verify they fail**

From `apps/api`: `bun test src/application/use-cases/create-community.test.ts src/application/use-cases/get-community.test.ts src/application/use-cases/join-community.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the three use-cases**

Each is a class with ports in the constructor and one `execute()`, throwing `application/errors.ts` classes. The two preconditions that must be enforced **in the use-case, before the repository**, are the empty slug and the owner-leaving case — the same discipline `FollowUser` applies to a self-follow, and for the same reason: a raw constraint error would abort an enclosing transaction.

The owner-leave message, in Bahasa Indonesia: `"pemilik tidak bisa keluar dari komunitasnya sendiri"`.
The reserved-slug message: `"nama ini tidak bisa dipakai, coba nama lain"`.
The taken-slug message: `"nama ini sudah dipakai komunitas lain"`.

- [ ] **Step 4: Run the tests**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/application/use-cases
git commit -m "feat: create, read and join use-cases for communities

Two preconditions are enforced here rather than left to a constraint: a
name with nothing sluggable, and an owner trying to leave their own
community. Both follow FollowUser's discipline on self-follow — a raw
constraint violation would abort an enclosing transaction, so the
use-case rejects it first and the tests assert the repository is never
reached.

viewerIsMember is null for a signed-out viewer and false for a signed-in
non-member. The join button renders differently for each: 'Masuk untuk
gabung' versus 'Gabung'."
```

---

### Task 5: Browse and roster use-cases

**Files:**
- Create: `apps/api/src/application/use-cases/browse-communities.ts` + `.test.ts`
- Create: `apps/api/src/application/use-cases/list-community-members.ts` + `.test.ts`

**Interfaces:**
- Consumes: `CommunityRepositoryPort` from Task 3; the limit constants from Task 2.
- Produces:
  - `BrowseCommunities` — `execute({ search, category, limit })` → `{ communities: CommunityListRow[] }`
  - `ListCommunityMembers` — `execute({ slug, limit })` → `{ members: CommunityMemberRow[], capped: boolean }`

- [ ] **Step 1: Write the failing tests**

Behaviours to pin:

*BrowseCommunities*
- the search string is trimmed and clamped to `MAX_COMMUNITY_SEARCH_LENGTH` before reaching the repository (assert on what the fake received)
- a category outside the six is rejected with a `ValidationError` and never reaches the repository — an arbitrary string in a WHERE clause is not something to pass through
- an absent category means "all", and the repository receives an empty string
- `limit` defaults to `DEFAULT_COMMUNITY_LIST_LIMIT` and is clamped to it when a caller asks for more

*ListCommunityMembers*
- an unknown slug is a `NotFoundError`
- `capped` is true when the repository returns exactly `limit` rows, false when fewer — the same honest-truncation shape `FollowListPage` already renders

- [ ] **Step 2: Run them to verify they fail**

From `apps/api`: `bun test src/application/use-cases/browse-communities.test.ts src/application/use-cases/list-community-members.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the two use-cases**

- [ ] **Step 4: Run the tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/application/use-cases
git commit -m "feat: browse and roster use-cases

The category is validated against the six rather than passed through: an
arbitrary string reaching a WHERE clause is not a thing to allow just
because the column is a varchar. The search string is trimmed and clamped
here, not in the repository, so every caller gets the same clamp."
```

---

### Task 6: Routes, wiring and route tests

**Files:**
- Create: `apps/api/src/routes/communities.ts` + `.test.ts`
- Modify: `apps/api/src/bootstrap.ts` (five `Dependencies` fields, the repository, five use-cases)
- Modify: `apps/api/src/app.ts` (mount `/communities`)

**Interfaces:**
- Consumes: every use-case from Tasks 4–5.
- Produces: the six HTTP endpoints. Task 7's `apiClient` calls them.

- [ ] **Step 1: Write the failing route tests**

Follow `routes/users.test.ts` for harness: `beforeEach(resetDatabase)`, an `app()` helper returning `createApp(bootstrap())`, a `tokenForValidUser` helper going through the real signup and login routes, and an `authed(token)` header helper.

Cases:
- `POST /communities` with no `Authorization` is 401
- `POST /communities` with a valid payload is 201 and returns the slug
- `POST /communities` with a category outside the six is 400
- `POST /communities` twice with the same name is 409
- `GET /communities` returns the list, unauthenticated
- `GET /communities?category=Skill%20Digital` filters
- `GET /communities?q=bimbel` searches
- `GET /communities/:slug` for an unknown slug is 404
- `GET /communities/:slug` signed out reports `viewerIsMember: null`
- `POST /communities/:slug/join` requires auth (401 without)
- `POST /communities/:slug/join` is 200 `{ member: true }`, and again is still 200 `{ member: true }` with the member count unmoved
- `DELETE /communities/:slug/join` is 200 `{ member: false }`
- the owner leaving their own community is 409
- `GET /communities/:slug/members` lists the owner first

- [ ] **Step 2: Run them to verify they fail**

From `apps/api`: `bun test src/routes/communities.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the router**

`export function communityRoutes(deps: Pick<Dependencies, …>)`. Use `requireUserAuth(deps.userTokenIssuer, deps.userRepository)` built once for the mutating routes, and `resolveViewerId(c, deps.userTokenIssuer, deps.userRepository)` inside the public handlers. Handlers map HTTP to use-case input and back — no `try`/`catch`; `app.onError(errorHandler)` turns thrown `AppError`s into responses.

- [ ] **Step 4: Wire `bootstrap()` and mount the router**

Add the repository and five use-cases to `Dependencies`, construct them in `bootstrap()`, return them. Mount in `app.ts` with `app.route("/communities", communityRoutes(deps));`.

- [ ] **Step 5: Run the tests**

From `apps/api`: `bun test src/routes/communities.test.ts`, then the full `bun test` and `bun run typecheck`.
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes apps/api/src/bootstrap.ts apps/api/src/app.ts
git commit -m "feat: the /communities router, wired

Six endpoints. The three read routes resolve an optional viewer rather
than requiring auth, the pattern /users/by-handle and /users/explore
already use — it is what lets a response distinguish an anonymous visitor
from a signed-in non-member."
```

---

### Task 7: The web client, the proxy, and the browse tabs

**Files:**
- Modify: `apps/web/vite.config.ts` (proxy `/communities`)
- Modify: `apps/web/src/user/apiClient.ts` (six functions + their response types)
- Modify: `apps/web/src/user/errorCopy.ts` (community failure copy)
- Create: `apps/web/src/user/communityColor.ts` + `.test.ts`
- Create: `apps/web/src/user/CommunityCard.tsx` + `.test.tsx`
- Modify: `apps/web/src/user/JelajahPage.tsx` + `.test.tsx` (two tabs)
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 6's endpoints.
- Produces: `communityColor(slug: string): string`; `CommunityCard`; `createCommunity`, `browseCommunities`, `getCommunity`, `joinCommunity`, `leaveCommunity`, `listCommunityMembers` in `apiClient.ts`. Task 8 consumes all of them.

- [ ] **Step 1: Add the proxy entry**

In `apps/web/vite.config.ts`, add `"/communities": "http://localhost:3000",` to the proxy table. `src/test/vite-proxy-coverage.test.ts` greps every fetch call site for its first path segment and fails if the table cannot match it, so omitting this reddens a test rather than failing silently at runtime.

- [ ] **Step 2: Write the failing colour test**

Create `apps/web/src/user/communityColor.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { COMMUNITY_COLORS, communityColor } from "./communityColor";

describe("communityColor", () => {
  it("is deterministic — the same slug always gets the same hue", () => {
    expect(communityColor("bimbel-sbmptn")).toBe(communityColor("bimbel-sbmptn"));
  });

  it("only ever returns a token from the palette, so a card cannot drift off-brand", () => {
    for (const slug of ["a", "bimbel-sbmptn", "kelas-desain", "zzz", "kajian-online"]) {
      expect(COMMUNITY_COLORS.includes(communityColor(slug))).toBe(true);
    }
  });

  it("spreads across the palette rather than collapsing onto one hue", () => {
    const slugs = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
    const distinct = new Set(slugs.map(communityColor));
    expect(distinct.size > 1).toBe(true);
  });

  it("handles an empty slug without throwing", () => {
    expect(COMMUNITY_COLORS.includes(communityColor(""))).toBe(true);
  });
});
```

- [ ] **Step 3: Write the colour function**

Create `apps/web/src/user/communityColor.ts`:

```ts
/**
 * The hues a community card may take, all Udara tokens.
 *
 * A community's colour is DERIVED from its slug rather than stored. The design
 * reference gives each community a colour on its Discover card; deriving it
 * means no column, no picker in the create form, and no way for a card to end
 * up off-palette. The cost is that a community cannot choose its colour, which
 * is a feature nobody has asked for.
 */
export const COMMUNITY_COLORS: readonly string[] = [
  "var(--langit)",
  "var(--hijau-lepas)",
  "var(--sinyal)",
  "var(--merah-senja)",
  "var(--langit-light)",
  "var(--kabut)",
];

/** FNV-1a, for a stable spread across the palette from a short string. */
export function communityColor(slug: string): string {
  let hash = 2166136261;
  for (let i = 0; i < slug.length; i += 1) {
    hash ^= slug.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const index = Math.abs(hash) % COMMUNITY_COLORS.length;
  return COMMUNITY_COLORS[index]!;
}
```

- [ ] **Step 4: Run the colour test**

From `apps/web`: `bun test src/user/communityColor.test.ts`
Expected: PASS, all four.

- [ ] **Step 5: Add the API client functions**

In `apps/web/src/user/apiClient.ts`, follow the file's existing shape exactly — the same `apiFetch` wrapper, the same exported response types, the same error handling. Add `browseCommunities`, `getCommunity`, `createCommunity`, `joinCommunity`, `leaveCommunity`, `listCommunityMembers`.

Add failure copy to `errorCopy.ts` as a `describeCommunityFailure`, deriving from the error's **shape** — never from a server message. `no-raw-server-errors.test.ts` enforces this.

- [ ] **Step 6: Write the failing `CommunityCard` test**

Create `apps/web/src/user/CommunityCard.test.tsx`. Assert by role and text: it renders the name as a link to `/komunitas/:slug`, renders the category and the member count in Bahasa Indonesia (`N anggota`), and renders the description when present and omits it entirely when absent.

- [ ] **Step 7: Write `CommunityCard`**

A `.card .card-clickable` article: an initial tile filled with `communityColor(slug)`, the name as a `<Link>`, the category, `N anggota`, and the description. Reuse the Udara classes; add no new colour literal.

- [ ] **Step 8: Write the failing `JelajahPage` tab tests**

Extend `apps/web/src/user/JelajahPage.test.tsx`. **Do not weaken any existing assertion** — every current test covers the Orang content and must keep passing unchanged, now inside a tab.

New cases: two tabs named `Komunitas` and `Orang`; the tab state lives in the URL as `?tab=`; the active tab carries `aria-current="true"`; the Komunitas tab renders community cards from the API; the search field submits rather than searching as you type; the category chips filter.

- [ ] **Step 9: Restructure `JelajahPage`**

Add the tab layer above the existing content. Keep `<main className="user-page jelajah-page">` and the `FollowRow` export — `FollowListPage` imports it. Reuse the `.feed-tabs` markup and classes Beranda already uses, so the indicator invariant that `BerandaPage.test.tsx` pins covers this page too.

- [ ] **Step 10: Add the browse styles**

In `apps/web/src/styles.css`, add the category chip row and the community grid. Every colour must be a token; the contrast guard will measure any rule declaring both a `color` and a `background`.

- [ ] **Step 11: Verify**

From `apps/web`: `bun test` and `bun run typecheck`, then `bun test src/test/` for the guards.
Expected: all green, including `vite-proxy-coverage`, `contrast`, `no-dangling-tokens`, `cascade-order` and `no-hardcoded-colours`.

- [ ] **Step 12: Commit**

```bash
git add apps/web/vite.config.ts apps/web/src/user apps/web/src/styles.css
git commit -m "feat: browse communities and people from one surface

/jelajah gains Komunitas and Orang tabs rather than the app gaining a
second search page. Two near-identical search boxes on adjacent menu
entries is the kind of thing users pick wrong every time, and the sidebar
stays at four items instead of growing toward seven.

A community's colour is derived from its slug with FNV-1a into a fixed
list of Udara tokens: no column, no picker in the create form, and no way
for a card to render off-palette."
```

---

### Task 8: CommunityHome and the create form

**Files:**
- Create: `apps/web/src/user/CommunityPage.tsx` + `.test.tsx`
- Create: `apps/web/src/user/CommunityCreatePage.tsx` + `.test.tsx`
- Modify: `apps/web/src/App.tsx` (two routes)
- Modify: `apps/web/src/styles.css` (banner)

**Interfaces:**
- Consumes: everything from Task 7.
- Produces: the finished phase.

- [ ] **Step 1: Write the failing `CommunityPage` tests**

Cases: the banner shows the name, `N anggota · Kategori`; a signed-out viewer sees `Masuk untuk gabung` linking to `/masuk`; a signed-in non-member sees a `Gabung` button that joins and flips to `Keluar`; the owner sees **no** join or leave control at all — not a disabled one, per the project's rule that a control is never rendered for an action that would fail; the roster lists members with the owner first; an unknown slug renders the shared `NotFoundPage`; a failed load shows copy from `errorCopy.ts` with `role="alert"`.

- [ ] **Step 2: Write `CommunityPage`**

`<main className="user-page community-page">` with `<Header title={community.name} />` above it — the shell pattern Phase 0 established for every page. The banner is the reference's `linear-gradient(120deg, var(--langit), var(--langit-dark))` with the initial tile, the name, the meta line, and the join control.

**No tab bar.** One tab is not a tab bar; Phase 2 adds it with Feed.

Loading, not-found and error are three separate early returns, the shape `ProfilePage` already uses.

- [ ] **Step 3: Write the failing `CommunityCreatePage` tests**

Cases: the form has Nama komunitas, Kategori (a `<select>` of exactly the six) and Deskripsi; submitting navigates to the new community; a duplicate name shows the conflict copy without losing what the user typed; a signed-out visitor is redirected to `/masuk`.

- [ ] **Step 4: Write `CommunityCreatePage`**

Follow `SignupPage`'s shape — a local `Field` helper, `noValidate`, a phase state machine, copy from `errorCopy.ts`.

- [ ] **Step 5: Register the routes**

In `apps/web/src/App.tsx`, inside the `AppShell` layout route, add `/komunitas/baru` **before** `/komunitas/:slug` so the literal wins, and both before the catch-all `/:handleParam`.

- [ ] **Step 6: Full verification**

From `apps/web`: `bun test`, `bun run typecheck`, `bun test src/test/`.
From `apps/api`: `bun test`, `bun run typecheck`.
From `packages/shared`: `bun test`.
Expected: all green, zero failures. Report the actual counts.

- [ ] **Step 7: Commit and stop**

Do **not** merge and do **not** push. Report to the repo owner: the test counts, that the migration in `apps/api/drizzle` is destructive and theirs to run, and that nothing has been rendered in a browser.

---

## Self-Review

**Spec coverage.** Deletion of the eighteen tables → Task 1. New tables and the shared contract → Task 2. Slug rules including reserved slugs → Task 3. The six endpoints → Tasks 4–6. Derived colour, no stored count, no `access_mode` → Tasks 2 and 7. Two-tab browse → Task 7. CommunityHome without a tab bar → Task 8. Create form → Task 8. Vite proxy → Task 7 Step 1. Owner-cannot-leave → Task 4. Roster cap → Task 5. Every spec section maps to a task.

**Placeholder scan.** Tasks 4, 5, 6 and 8 describe test *cases* in prose rather than quoting every assertion, which is a deliberate departure from this plan's own rule and I am flagging it rather than hiding it: each names the exact behaviour, the exact error class, and the exact Indonesian message where one is user-visible, and each points at a real file in this repo to copy the harness from. Quoting ~60 assertions verbatim would have made this document longer than the code. If an implementer finds a case underspecified, that is a plan defect — report it rather than guessing.

**Type consistency.** `CommunityRecord`, `CommunityListRow`, `CommunityMemberRow` and `CommunityDetail` are declared once each in Task 3 or 4 and referenced by those exact names afterward. `communityColor(slug: string): string` matches its call sites. `DEFAULT_COMMUNITY_MEMBER_LIMIT` is defined in Task 2 and consumed in Task 5. `viewerIsMember` is `boolean | null` everywhere it appears.

**Known hazard.** Task 1 removes `communitySlug` from `UniqueRule` and Task 2's constraint needs a rule again. Task 1 Step 5 says to flag this; Task 3 Step 8's uniqueness translation is where it lands. If the two tasks are executed by different agents, this is the seam most likely to drop.
