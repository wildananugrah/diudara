# Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the DIUDARA monorepo foundation: a working Bun/Hono API backed by a
fully-migrated Postgres schema (via Drizzle), with the ports-and-adapters layering pattern
proven end-to-end through one real repository and a composition root.

**Architecture:** A Bun workspaces monorepo, with `apps/api` as the only package built in
this phase. Hono handles HTTP. Drizzle owns the Postgres schema and migrations. A
composition root (`bootstrap.ts`) wires concrete adapters into port interfaces — proven
here via `CreatorRepositoryPort` / `DrizzleCreatorRepository` — establishing the exact
pattern every later phase's use-cases will follow (payments, messaging, AI, streaming).

**Tech Stack:** Bun, Hono, PostgreSQL 16, Drizzle ORM + Drizzle Kit, `postgres` (postgres.js
driver), `bun:test`.

## Global Constraints

Copied verbatim (or near-verbatim) from `docs/superpowers/specs/2026-08-07-diudara-mvp-design.md`.
Every task's work implicitly includes these, even tasks that don't touch them directly:

- Backend must follow ports-and-adapters (SOLID) layering: use-cases/application code
  depends only on port interfaces, never on concrete SDKs directly (spec §5).
- Database is PostgreSQL, accessed exclusively through Drizzle ORM (spec §3, §7).
- No payment/card data is ever stored directly by our system — only gateway references
  (spec §10). Not exercised in this phase, binding from Phase 3 onward.
- Every membership/status-changing action must write an `activity_log` entry with a
  timestamp (spec §10). Binding from Phase 3 onward.
- `activity_log.member_id` must be nullable, to support community-scoped events with no
  single associated member (spec §7).
- `subscription` carries `retry_count` and `last_attempt_at` columns for the day 1/3/7
  retry schedule (spec §7). Used starting Phase 5.
- Runtime and package manager is Bun throughout; the test runner is `bun test` (spec §3, §11).

---

### Task 1: Monorepo scaffolding + API health check

**Files:**
- Create: `package.json` (repo root)
- Create: `tsconfig.base.json` (repo root)
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/server.ts`
- Test: `apps/api/src/routes/health.test.ts`
- Modify: `.gitignore` (repo root)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `createApp(): Hono` exported from `apps/api/src/app.ts`, mounting a
  `GET /health` route that returns `{ status: "ok" }` with HTTP 200. Later tasks (Task 7)
  will change this signature to `createApp(deps: Dependencies): Hono` — noted there.

- [ ] **Step 1: Scaffold the workspace and write the failing test**

Create `package.json` at the repo root:

```json
{
  "name": "diudara",
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ]
}
```

Create `tsconfig.base.json` at the repo root:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["bun-types"]
  }
}
```

Create `apps/api/package.json`:

```json
{
  "name": "@diudara/api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --hot src/server.ts",
    "test": "bun test"
  },
  "dependencies": {
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

Create `apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src"]
}
```

Append to the repo-root `.gitignore` (keep the existing `docs/server` line):

```
docs/server
node_modules
dist
.env
.DS_Store
```

Now write the failing test at `apps/api/src/routes/health.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createApp } from "../app";

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 2: Install dependencies and run the test to verify it fails**

```bash
cd apps/api
bun install
bun test src/routes/health.test.ts
```

Expected: FAIL — `../app` cannot be resolved (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `apps/api/src/routes/health.ts`:

```ts
import { Hono } from "hono";

export const healthRoute = new Hono().get("/", (c) => c.json({ status: "ok" }));
```

Create `apps/api/src/app.ts`:

```ts
import { Hono } from "hono";
import { healthRoute } from "./routes/health";

export function createApp() {
  const app = new Hono();
  app.route("/health", healthRoute);
  return app;
}
```

Create `apps/api/src/server.ts`:

```ts
import { createApp } from "./app";

const app = createApp();

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test src/routes/health.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../..
git add package.json tsconfig.base.json .gitignore apps/api bun.lock
git commit -m "feat: scaffold Bun+Hono API with health check"
```

---

### Task 2: Local Postgres via docker-compose + raw connectivity check

**Files:**
- Create: `infra/docker-compose.yml`
- Create: `apps/api/.env.example`
- Create: `apps/api/src/db/client.ts`
- Test: `apps/api/src/db/client.test.ts`

**Interfaces:**
- Consumes: nothing new (independent of Task 1's HTTP layer).
- Produces: `sql` exported from `apps/api/src/db/client.ts` — a `postgres.js` client
  instance (tagged-template query function), and `db` — a Drizzle instance wrapping it
  (schema-less until Task 3, but the export exists now so Task 3 only has to add the
  `schema` option).

- [ ] **Step 1: Write the docker-compose service and env template**

Create `infra/docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: diudara
      POSTGRES_PASSWORD: diudara_dev_password
      POSTGRES_DB: diudara
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

Create `apps/api/.env.example`:

```
DATABASE_URL=postgres://diudara:diudara_dev_password@localhost:5432/diudara
PORT=3000
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/db/client.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { sql } from "./client";

describe("postgres connection", () => {
  it("connects and executes a basic query", async () => {
    const rows = await sql`select 1 as one`;
    expect(rows[0].one).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/api
bun test src/db/client.test.ts
```

Expected: FAIL — `./client` cannot be resolved (module does not exist yet).

- [ ] **Step 4: Write the minimal implementation**

```bash
bun add postgres drizzle-orm
```

Create `apps/api/src/db/client.ts`:

```ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export const sql = postgres(connectionString);
export const db = drizzle(sql);
```

- [ ] **Step 5: Start Postgres and run the test to verify it passes**

```bash
cp .env.example .env
docker compose -f ../../infra/docker-compose.yml up -d postgres
bun test src/db/client.test.ts
```

Expected: PASS. If it still fails, run `docker compose -f ../../infra/docker-compose.yml logs postgres`
to confirm the container is healthy before retrying.

- [ ] **Step 6: Commit**

```bash
cd ../..
git add infra/docker-compose.yml apps/api/.env.example apps/api/src/db/client.ts \
  apps/api/src/db/client.test.ts apps/api/package.json bun.lock
git commit -m "feat: add local Postgres via docker-compose and a raw connectivity check"
```

---

### Task 3: Core Fase 1 Drizzle schema + migrations

**Files:**
- Create: `apps/api/drizzle.config.ts`
- Create: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/db/test-helpers.ts`
- Modify: `apps/api/src/db/client.ts`
- Modify: `apps/api/package.json`
- Test: `apps/api/src/db/schema.test.ts`

**Interfaces:**
- Consumes: `sql` from `apps/api/src/db/client.ts` (Task 2).
- Produces: Drizzle table objects `creators`, `communities`, `membershipTiers`,
  `channels`, `members`, `subscriptions`, `transactions`, `activityLogs` exported from
  `apps/api/src/db/schema.ts`. `db` from `client.ts` is now schema-aware
  (`drizzle(sql, { schema })`), used by all later tasks that touch the database.
  `resetDatabase(): Promise<void>` exported from `apps/api/src/db/test-helpers.ts` —
  deletes all rows across tables in foreign-key-safe (child-before-parent) order. Every
  integration test in this and later phases calls this in `beforeEach` instead of
  deleting its own subset of tables, so leftover rows from one test file can never leave
  a dangling foreign key that breaks another test file's cleanup. Task 4 extends this
  function's table list; it must stay the single source of truth for test cleanup.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/schema.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./client";
import { creators, communities, membershipTiers } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

describe("core schema round-trip", () => {
  it("persists and reads back a creator, community, and membership tier", async () => {
    const [creator] = await db
      .insert(creators)
      .values({ name: "Budi", whatsappNumber: "+6281111111111", tierPlan: "starter" })
      .returning();

    const [community] = await db
      .insert(communities)
      .values({ creatorId: creator.id, name: "Kelas Bimbel Budi", niche: "bimbel" })
      .returning();

    const [tier] = await db
      .insert(membershipTiers)
      .values({
        communityId: community.id,
        name: "Basic",
        priceAmount: 50000,
        billingCycle: "monthly",
      })
      .returning();

    const [found] = await db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.id, tier.id));

    expect(found.name).toBe("Basic");
    expect(found.communityId).toBe(community.id);
    expect(found.isActive).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api
bun test src/db/schema.test.ts
```

Expected: FAIL — `./schema` cannot be resolved (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

```bash
bun add -d drizzle-kit
```

Create `apps/api/src/db/schema.ts`:

```ts
import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
} from "drizzle-orm/pg-core";

export const creators = pgTable("creator", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  whatsappNumber: varchar("whatsapp_number", { length: 32 }).notNull(),
  email: varchar("email", { length: 255 }),
  tierPlan: varchar("tier_plan", { length: 32 }).notNull().default("starter"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const communities = pgTable("community", {
  id: uuid("id").primaryKey().defaultRandom(),
  creatorId: uuid("creator_id").notNull().references(() => creators.id),
  name: varchar("name", { length: 255 }).notNull(),
  niche: varchar("niche", { length: 128 }),
  status: varchar("status", { length: 32 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const membershipTiers = pgTable("membership_tier", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id").notNull().references(() => communities.id),
  name: varchar("name", { length: 128 }).notNull(),
  priceAmount: integer("price_amount").notNull(),
  billingCycle: varchar("billing_cycle", { length: 16 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

export const channels = pgTable("channel", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id").notNull().references(() => communities.id),
  platform: varchar("platform", { length: 16 }).notNull(),
  externalGroupId: varchar("external_group_id", { length: 255 }),
  inviteLink: varchar("invite_link", { length: 512 }),
  botStatus: varchar("bot_status", { length: 32 }).notNull().default("disconnected"),
});

export const members = pgTable("member", {
  id: uuid("id").primaryKey().defaultRandom(),
  whatsappNumber: varchar("whatsapp_number", { length: 32 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable("subscription", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id").notNull().references(() => members.id),
  tierId: uuid("tier_id").notNull().references(() => membershipTiers.id),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  nextBillingDate: date("next_billing_date"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  retryCount: integer("retry_count").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
});

export const transactions = pgTable("transaction", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: uuid("subscription_id").notNull().references(() => subscriptions.id),
  amount: integer("amount").notNull(),
  paymentMethod: varchar("payment_method", { length: 16 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  gatewayReferenceId: varchar("gateway_reference_id", { length: 255 }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

export const activityLogs = pgTable("activity_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id").references(() => members.id),
  communityId: uuid("community_id").notNull().references(() => communities.id),
  eventType: varchar("event_type", { length: 32 }).notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Create `apps/api/src/db/test-helpers.ts`:

```ts
import { db } from "./client";
import {
  activityLogs,
  transactions,
  subscriptions,
  channels,
  membershipTiers,
  communities,
  members,
  creators,
} from "./schema";

export async function resetDatabase() {
  await db.delete(activityLogs);
  await db.delete(transactions);
  await db.delete(subscriptions);
  await db.delete(channels);
  await db.delete(membershipTiers);
  await db.delete(communities);
  await db.delete(members);
  await db.delete(creators);
}
```

Update `apps/api/src/db/client.ts` to make `db` schema-aware:

```ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export const sql = postgres(connectionString);
export const db = drizzle(sql, { schema });
```

Create `apps/api/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

Add scripts to `apps/api/package.json` (merge into the existing `"scripts"` object):

```json
{
  "scripts": {
    "dev": "bun run --hot src/server.ts",
    "test": "bun test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

Generate and apply the migration:

```bash
bun run db:generate
bun run db:migrate
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test src/db/schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../..
git add apps/api/drizzle.config.ts apps/api/src/db/schema.ts apps/api/src/db/test-helpers.ts \
  apps/api/src/db/client.ts apps/api/package.json apps/api/drizzle apps/api/src/db/schema.test.ts \
  bun.lock
git commit -m "feat: add core Fase 1 Drizzle schema and migrations"
```

---

### Task 4: Extended/stubbed schema tables (course, enrollment, event with streaming fields, event_rsvp)

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/test-helpers.ts`
- Test: `apps/api/src/db/schema-extended.test.ts`

**Interfaces:**
- Consumes: `creators`, `communities`, `members` from `apps/api/src/db/schema.ts` (Task 3),
  `resetDatabase` from `apps/api/src/db/test-helpers.ts` (Task 3).
- Produces: additional Drizzle table objects `courses`, `enrollments`, `events`,
  `eventRsvps` exported from `apps/api/src/db/schema.ts`. `events` carries the
  live-streaming fields (`streamKey`, `status`, `hlsPlaybackPath`, `recordingUrl`) that
  Phase 8 will read/write. `resetDatabase` now also clears these four tables, ahead of
  `communities`/`members` in delete order.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/schema-extended.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import { creators, communities, events } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

describe("extended schema — event with streaming fields", () => {
  it("creates an event defaulting to status 'scheduled' with nullable streaming fields", async () => {
    const [creator] = await db
      .insert(creators)
      .values({ name: "Sinta", whatsappNumber: "+6281222222222" })
      .returning();
    const [community] = await db
      .insert(communities)
      .values({ creatorId: creator.id, name: "Kelas Sinta" })
      .returning();

    const [event] = await db
      .insert(events)
      .values({ communityId: community.id, title: "Sesi Live Perdana" })
      .returning();

    expect(event.status).toBe("scheduled");
    expect(event.streamKey).toBeNull();
    expect(event.recordingUrl).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api
bun test src/db/schema-extended.test.ts
```

Expected: FAIL — `events` is not exported from `./schema` (does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Append to `apps/api/src/db/schema.ts` (after the `activityLogs` export):

```ts
export const courses = pgTable("course", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id").notNull().references(() => communities.id),
  title: varchar("title", { length: 255 }).notNull(),
  dripSchedule: jsonb("drip_schedule"),
});

export const enrollments = pgTable("enrollment", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id").notNull().references(() => members.id),
  courseId: uuid("course_id").notNull().references(() => courses.id),
  progressPercent: integer("progress_percent").notNull().default(0),
  certificateStatus: varchar("certificate_status", { length: 32 }),
});

export const events = pgTable("event", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id").notNull().references(() => communities.id),
  title: varchar("title", { length: 255 }).notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  meetingLink: varchar("meeting_link", { length: 512 }),
  streamKey: varchar("stream_key", { length: 128 }),
  status: varchar("status", { length: 16 }).notNull().default("scheduled"),
  hlsPlaybackPath: varchar("hls_playback_path", { length: 512 }),
  recordingUrl: varchar("recording_url", { length: 512 }),
});

export const eventRsvps = pgTable("event_rsvp", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id").notNull().references(() => members.id),
  eventId: uuid("event_id").notNull().references(() => events.id),
  status: varchar("status", { length: 16 }).notNull().default("registered"),
});
```

Replace the contents of `apps/api/src/db/test-helpers.ts` to also clear the new tables
(child tables first, before the `communities`/`members` they reference):

```ts
import { db } from "./client";
import {
  eventRsvps,
  events,
  enrollments,
  courses,
  activityLogs,
  transactions,
  subscriptions,
  channels,
  membershipTiers,
  communities,
  members,
  creators,
} from "./schema";

export async function resetDatabase() {
  await db.delete(eventRsvps);
  await db.delete(events);
  await db.delete(enrollments);
  await db.delete(courses);
  await db.delete(activityLogs);
  await db.delete(transactions);
  await db.delete(subscriptions);
  await db.delete(channels);
  await db.delete(membershipTiers);
  await db.delete(communities);
  await db.delete(members);
  await db.delete(creators);
}
```

Generate and apply the migration:

```bash
bun run db:generate
bun run db:migrate
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test src/db/schema-extended.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../..
git add apps/api/src/db/schema.ts apps/api/src/db/test-helpers.ts apps/api/drizzle \
  apps/api/src/db/schema-extended.test.ts
git commit -m "feat: add extended schema tables (course, enrollment, event with streaming fields, event_rsvp)"
```

---

### Task 5: MembershipTier domain entity

**Files:**
- Create: `apps/api/src/domain/membership-tier.ts`
- Test: `apps/api/src/domain/membership-tier.test.ts`

**Interfaces:**
- Consumes: nothing (pure domain code, no framework/database dependency).
- Produces: `MembershipTier` type and `createMembershipTier(input): MembershipTier`
  factory exported from `apps/api/src/domain/membership-tier.ts`. This establishes the
  domain-entity pattern (validate invariants, throw on violation, return a plain object)
  that later phases follow for `Subscription`, `Transaction`, etc. as their use-cases need
  them.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/domain/membership-tier.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createMembershipTier } from "./membership-tier";

describe("createMembershipTier", () => {
  it("creates a valid tier, defaulting isActive to true", () => {
    const tier = createMembershipTier({
      id: "tier-1",
      communityId: "community-1",
      name: "Basic",
      priceAmount: 50000,
      billingCycle: "monthly",
    });

    expect(tier.isActive).toBe(true);
    expect(tier.priceAmount).toBe(50000);
  });

  it("rejects a negative priceAmount", () => {
    expect(() =>
      createMembershipTier({
        id: "tier-1",
        communityId: "community-1",
        name: "Basic",
        priceAmount: -1000,
        billingCycle: "monthly",
      })
    ).toThrow("priceAmount must not be negative");
  });

  it("rejects an empty name", () => {
    expect(() =>
      createMembershipTier({
        id: "tier-1",
        communityId: "community-1",
        name: "   ",
        priceAmount: 50000,
        billingCycle: "monthly",
      })
    ).toThrow("name must not be empty");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api
bun test src/domain/membership-tier.test.ts
```

Expected: FAIL — `./membership-tier` cannot be resolved (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `apps/api/src/domain/membership-tier.ts`:

```ts
export type BillingCycle = "monthly" | "quarterly" | "yearly";

export interface MembershipTier {
  id: string;
  communityId: string;
  name: string;
  priceAmount: number;
  billingCycle: BillingCycle;
  isActive: boolean;
}

const VALID_BILLING_CYCLES: BillingCycle[] = ["monthly", "quarterly", "yearly"];

export function createMembershipTier(input: {
  id: string;
  communityId: string;
  name: string;
  priceAmount: number;
  billingCycle: BillingCycle;
  isActive?: boolean;
}): MembershipTier {
  if (input.priceAmount < 0) {
    throw new Error("priceAmount must not be negative");
  }
  if (!VALID_BILLING_CYCLES.includes(input.billingCycle)) {
    throw new Error(`billingCycle must be one of ${VALID_BILLING_CYCLES.join(", ")}`);
  }
  if (input.name.trim().length === 0) {
    throw new Error("name must not be empty");
  }

  return {
    id: input.id,
    communityId: input.communityId,
    name: input.name,
    priceAmount: input.priceAmount,
    billingCycle: input.billingCycle,
    isActive: input.isActive ?? true,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test src/domain/membership-tier.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../..
git add apps/api/src/domain
git commit -m "feat: add MembershipTier domain entity"
```

---

### Task 6: CreatorRepositoryPort + DrizzleCreatorRepository adapter + composition root

**Files:**
- Create: `apps/api/src/application/ports/creator-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-creator.repository.ts`
- Create: `apps/api/src/bootstrap.ts`
- Test: `apps/api/src/infrastructure/repositories/drizzle-creator.repository.test.ts`

**Interfaces:**
- Consumes: `db` from `apps/api/src/db/client.ts` (Task 3), `creators` table from
  `apps/api/src/db/schema.ts` (Task 3), `resetDatabase` from
  `apps/api/src/db/test-helpers.ts` (Task 3/4).
- Produces:
  - `CreatorRepositoryPort` interface (`create`, `findById`, `findByEmail`) from
    `apps/api/src/application/ports/creator-repository.port.ts`.
  - `DrizzleCreatorRepository` class implementing it, from
    `apps/api/src/infrastructure/repositories/drizzle-creator.repository.ts`.
  - `bootstrap(): Dependencies` from `apps/api/src/bootstrap.ts`, currently returning
    `{ creatorRepository: CreatorRepositoryPort }`. Task 7 extends this return shape.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/application/ports/creator-repository.port.ts`:

```ts
export interface CreatorRecord {
  id: string;
  name: string;
  whatsappNumber: string;
  email: string | null;
  tierPlan: string;
  createdAt: Date;
}

export interface CreatorRepositoryPort {
  create(input: { name: string; whatsappNumber: string; email?: string }): Promise<CreatorRecord>;
  findById(id: string): Promise<CreatorRecord | null>;
  findByEmail(email: string): Promise<CreatorRecord | null>;
}
```

Create `apps/api/src/infrastructure/repositories/drizzle-creator.repository.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleCreatorRepository } from "./drizzle-creator.repository";

beforeEach(resetDatabase);

describe("DrizzleCreatorRepository", () => {
  it("creates a creator and finds it by id and email", async () => {
    const repository = new DrizzleCreatorRepository(db);

    const created = await repository.create({
      name: "Dewi",
      whatsappNumber: "+6281333333333",
      email: "dewi@example.com",
    });

    const byId = await repository.findById(created.id);
    const byEmail = await repository.findByEmail("dewi@example.com");

    expect(byId?.name).toBe("Dewi");
    expect(byEmail?.id).toBe(created.id);
  });

  it("returns null when a creator is not found", async () => {
    const repository = new DrizzleCreatorRepository(db);
    const result = await repository.findById("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api
bun test src/infrastructure/repositories/drizzle-creator.repository.test.ts
```

Expected: FAIL — `./drizzle-creator.repository` cannot be resolved (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `apps/api/src/infrastructure/repositories/drizzle-creator.repository.ts`:

```ts
import { eq } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { creators } from "../../db/schema";
import type {
  CreatorRecord,
  CreatorRepositoryPort,
} from "../../application/ports/creator-repository.port";

export class DrizzleCreatorRepository implements CreatorRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

  async create(input: {
    name: string;
    whatsappNumber: string;
    email?: string;
  }): Promise<CreatorRecord> {
    const [row] = await this.db
      .insert(creators)
      .values({
        name: input.name,
        whatsappNumber: input.whatsappNumber,
        email: input.email,
      })
      .returning();
    return row;
  }

  async findById(id: string): Promise<CreatorRecord | null> {
    const [row] = await this.db.select().from(creators).where(eq(creators.id, id));
    return row ?? null;
  }

  async findByEmail(email: string): Promise<CreatorRecord | null> {
    const [row] = await this.db.select().from(creators).where(eq(creators.email, email));
    return row ?? null;
  }
}
```

Create `apps/api/src/bootstrap.ts`:

```ts
import { db } from "./db/client";
import { DrizzleCreatorRepository } from "./infrastructure/repositories/drizzle-creator.repository";

export function bootstrap() {
  const creatorRepository = new DrizzleCreatorRepository(db);

  return {
    creatorRepository,
  };
}

export type Dependencies = ReturnType<typeof bootstrap>;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test src/infrastructure/repositories/drizzle-creator.repository.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../..
git add apps/api/src/application apps/api/src/infrastructure apps/api/src/bootstrap.ts
git commit -m "feat: add CreatorRepositoryPort, Drizzle adapter, and composition root"
```

---

### Task 7: Wire the composition root into the app with a DB-aware health check

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/routes/health.ts`
- Modify: `apps/api/src/routes/health.test.ts`
- Modify: `apps/api/src/bootstrap.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `bootstrap()` and `Dependencies` from `apps/api/src/bootstrap.ts` (Task 6),
  `sql` from `apps/api/src/db/client.ts` (Task 2/3).
- Produces: `createApp(deps: Dependencies): Hono` (signature change from Task 1 — now
  requires injected dependencies). `Dependencies` now also includes `sql`. Every later
  phase's routes are mounted through this same `createApp(deps)` entry point.

- [ ] **Step 1: Write the failing test**

Replace the contents of `apps/api/src/routes/health.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";

describe("GET /health", () => {
  it("returns 200 with status ok when the database is reachable", async () => {
    const app = createApp(bootstrap());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api
bun test src/routes/health.test.ts
```

Expected: FAIL (type error / runtime error) — `createApp` does not yet accept an argument,
and `healthRoute` does not yet check the database.

- [ ] **Step 3: Write the minimal implementation**

Replace the contents of `apps/api/src/bootstrap.ts`:

```ts
import { db, sql } from "./db/client";
import { DrizzleCreatorRepository } from "./infrastructure/repositories/drizzle-creator.repository";

export function bootstrap() {
  const creatorRepository = new DrizzleCreatorRepository(db);

  return {
    creatorRepository,
    sql,
  };
}

export type Dependencies = ReturnType<typeof bootstrap>;
```

Replace the contents of `apps/api/src/routes/health.ts`:

```ts
import { Hono } from "hono";
import type { Dependencies } from "../bootstrap";

export function healthRoute(deps: Dependencies) {
  return new Hono().get("/", async (c) => {
    await deps.sql`select 1`;
    return c.json({ status: "ok" });
  });
}
```

Replace the contents of `apps/api/src/app.ts`:

```ts
import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import type { Dependencies } from "./bootstrap";

export function createApp(deps: Dependencies) {
  const app = new Hono();
  app.route("/health", healthRoute(deps));
  return app;
}
```

Replace the contents of `apps/api/src/server.ts`:

```ts
import { bootstrap } from "./bootstrap";
import { createApp } from "./app";

const deps = bootstrap();
const app = createApp(deps);

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test src/routes/health.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full test suite for this phase**

```bash
bun test
```

Expected: PASS — all tests from Tasks 1–7 pass together.

- [ ] **Step 6: Commit**

```bash
cd ../..
git add apps/api/src/app.ts apps/api/src/routes/health.ts apps/api/src/routes/health.test.ts \
  apps/api/src/bootstrap.ts apps/api/src/server.ts
git commit -m "feat: wire composition root into app with DB-aware health check"
```
