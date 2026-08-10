# Phase 7: AI Co-Builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator has a Bahasa Indonesia conversation about their community and ends up with a
pre-filled create form — community name, description, tiers and welcome message — that they edit and
save through the endpoints they would have used by hand.

**Architecture:** An `AiProviderPort` returning **parsed, schema-conforming data or a throw** — never
raw model text. A deliberately hostile fake adapter drives every test. The AI produces a **draft
only**; saving goes through Phase 2's existing `POST /communities` and `POST …/tiers`, so the AI path
cannot bypass any rule the manual path enforces. Spend is capped per creator per day in Postgres.

**Tech Stack:** Bun, Hono, PostgreSQL 16, Drizzle, Zod via `@diudara/shared`, Vite + React,
`bun:test`, `@testing-library/react` + happy-dom.

## Global Constraints

From `docs/superpowers/specs/2026-08-10-phase7-ai-cobuilder-design.md` and inherited from Phases 1-6.

- **The AI never writes to the database.** It returns a draft; the creator edits it; saving uses the
  existing Phase 2 endpoints. A hallucinated tier price must not become real money because someone
  clicked "yes".
- **Model output is untrusted data, never instructions.** Zod-validated, length-bounded, rendered as
  text. **No `dangerouslySetInnerHTML` anywhere near it.** The realistic vector is a creator pasting
  text from elsewhere that carries instructions.
- **The port returns parsed data or throws.** Never raw model text, never a half-parsed object.
- **Retry exactly once** on malformed output, then fail honestly. An unbounded retry doubles a bill
  and hides a broken prompt.
- **The daily cap's check and increment happen in ONE statement**, so two concurrent requests cannot
  both pass with one slot left. Database arbitrates — the rule every phase since 2 has followed.
- **Creator scoping lives in the repository**, no unscoped variant; cross-creator returns **404, not
  403**, and leaks nothing in the response text.
- `NODE_ENV` **allowlist** (`RELAXED_NODE_ENVS` already exists in `bootstrap.ts`): only exactly
  `development`/`test` may relax a guard. **But unlike payments, an absent AI key is not a reason to
  refuse to boot** — production boots with the feature disabled and the chat screen hidden.
- Ports-and-adapters; Drizzle only; **generated** migrations only; never edit an applied migration
  (`0000`-`0015`).
- Bun throughout; root `bun run test` and `bun run typecheck` green across four workspaces.
- Tests use `resetDatabase()`; add every new table to its delete list. Per-run test databases exist
  since Phase 5, so the suite is safe to run concurrently.
- **A failing `expect(<DOM element>).toBeNull()` hangs `bun test`** (178s, 335MB). There is a
  source-scan guard at `apps/web/src/test/no-hanging-dom-assertions.test.ts`. Count elements or
  assert booleans instead.

## Facts about the existing code — use these rather than rediscovering them

- **Adapter pattern to copy:** `apps/api/src/infrastructure/payments/xendit-payment.adapter.ts` —
  injected `fetchFn` so tests assert the outgoing request with no network call, an
  `UNVERIFIED AGAINST THE LIVE …` warning comment, a `requireString`-style response validator that
  **throws** rather than producing `String(undefined)`, `AbortSignal.timeout`, and errors that never
  contain the secret.
- **Env gating:** `bootstrap.ts` exports `RELAXED_NODE_ENVS` (`{"development","test"}`) and
  `isRelaxedNodeEnv(nodeEnv)`. Reuse them; do not write a second gate.
- **`GET /communities/:id` does not exist.** Phase 6's five dashboard screens each refetch the whole
  list because of it. Task 6 adds it.
- Dashboard conventions (`apps/web/src/dashboard/`): `apiClient.ts` (Bearer + 401 → clear token and
  redirect), `useLoad.ts`, `ui.tsx`, `format.ts`, `types.ts`, page-per-screen under `pages/`, plain
  hand-written CSS in `styles.css`, Indonesian copy throughout.
- `packages/shared` holds Zod request schemas; `apps/web/src/dashboard/types.ts` hand-mirrors seven
  API response types (a known carry-forward — do not make it worse).

## Honest limitation to preserve

`OpenRouterAiAdapter` **cannot be verified** — there is no key. Xendit and Telegram are also
unverified, so this is the third. It matters most here: a fake returning clean JSON proves the port
contract and nothing about how a real model behaves. Do not write tests that appear to prove
otherwise, and do not delete the warning comment the adapter carries.

---

### Task 1: Schema — conversations, messages, usage

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/test-helpers.ts`
- Test: `apps/api/src/db/schema-phase7.test.ts`

**Interfaces:**
- Produces `aiConversations`, `aiMessages`, `aiUsage` Drizzle tables; `resetDatabase()` clears all
  three (messages before conversations — FK order).
- `aiUsage` is **unique on `(creator_id, usage_date)`**. That constraint is what makes the spend cap
  safe under concurrency; it must exist in the **database**, not only in the Drizzle definition.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/schema-phase7.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import { aiConversations, aiMessages, aiUsage, creators } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

async function seedCreator() {
  const [creator] = await db
    .insert(creators)
    .values({ name: "Budi", email: `b-${Date.now()}-${Math.random()}@example.com` })
    .returning();
  return creator;
}

describe("phase 7 schema", () => {
  it("stores a conversation and its messages", async () => {
    const creator = await seedCreator();
    const [conversation] = await db
      .insert(aiConversations)
      .values({ creatorId: creator.id })
      .returning();

    await db.insert(aiMessages).values({
      conversationId: conversation.id,
      role: "user",
      content: "Komunitas saya tentang bimbel matematika",
    });

    const rows = await db.select().from(aiMessages);
    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe("user");
  });

  it("rejects a second usage row for the same creator and day", async () => {
    const creator = await seedCreator();
    await db.insert(aiUsage).values({ creatorId: creator.id, usageDate: "2026-08-10" });

    let failed = false;
    try {
      await db.insert(aiUsage).values({ creatorId: creator.id, usageDate: "2026-08-10" });
    } catch {
      failed = true;
    }

    // This constraint is what makes the spend cap safe under concurrency:
    // the check-and-increment is one upsert, and the database arbitrates.
    expect(failed).toBe(true);
    expect((await db.select().from(aiUsage)).length).toBe(1);
  });

  it("defaults a usage row to zero messages", async () => {
    const creator = await seedCreator();
    const [row] = await db
      .insert(aiUsage)
      .values({ creatorId: creator.id, usageDate: "2026-08-10" })
      .returning();
    expect(row.messageCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && bun test src/db/schema-phase7.test.ts
```

Expected: FAIL — `aiConversations`, `aiMessages`, `aiUsage` are not exported.

- [ ] **Step 3: Implement**

Append to `apps/api/src/db/schema.ts`:

```ts
export const aiConversations = pgTable(
  "ai_conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ai_conversation_creator_idx").on(table.creatorId, table.createdAt)]
);

export const aiMessages = pgTable(
  "ai_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id),
    role: varchar("role", { length: 16 }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ai_message_conversation_idx").on(table.conversationId, table.createdAt)]
);

/**
 * One row per creator per UTC day. UNIQUE (creator_id, usage_date) is what lets
 * the cap be enforced by a single upsert — two concurrent requests cannot both
 * pass a limit with one slot left, because the database arbitrates rather than
 * a read-then-write in application code.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    usageDate: date("usage_date").notNull(),
    messageCount: integer("message_count").notNull().default(0),
  },
  (table) => [uniqueIndex("ai_usage_creator_date_unique").on(table.creatorId, table.usageDate)]
);
```

Add `text` to the `drizzle-orm/pg-core` import if absent.

In `test-helpers.ts`, import all three and delete them **before** `creators`, with `aiMessages`
before `aiConversations`.

Generate and apply:

```bash
bun run db:generate && bun run db:migrate
```

- [ ] **Step 4: Verify, including in live Postgres**

```bash
bun test src/db/schema-phase7.test.ts
docker compose -f ../../infra/docker-compose.yml exec -T postgres \
  psql -U diudara -d diudara -c "\d ai_usage"
```

Confirm `ai_usage_creator_date_unique` is a real UNIQUE index, then:

```bash
cd ../.. && bun run test && bun run typecheck
git add apps/api/src/db apps/api/drizzle
git commit -m "feat(db): add ai conversation, message and usage tables"
```

---

### Task 2: `AiProviderPort` and the hostile fake

**Files:**
- Create: `apps/api/src/application/ports/ai-provider.port.ts`
- Create: `apps/api/src/infrastructure/ai/fake-ai.adapter.ts`
- Create: `packages/shared/src/ai.schema.ts`, and export it from `packages/shared/src/index.ts`
- Test: `apps/api/src/infrastructure/ai/fake-ai.adapter.test.ts`
- Test: `packages/shared/src/ai.schema.test.ts`

**Interfaces:**
- `communityDraftSchema` in `@diudara/shared` — the Zod shape the model must produce:
  `{ name, niche, description, welcomeMessage, tiers: [{ name, priceAmount, billingCycle }] }`
  with 1–3 tiers, integer Rupiah, and lengths matching the existing DB columns
- `AiProviderPort.converse({ messages }): Promise<AiTurn>` where
  `AiTurn = { reply: string; draft: CommunityDraft | null }`
- `FakeAiAdapter` with a `nextBehaviour` switch: `"draft"`, `"reply-only"`, `"prose"`,
  `"truncated-json"`, `"fenced-json"`, `"refusal"`, `"injection"`, `"timeout"`

**The fake is the point of this task.** A fake that always returns clean JSON proves the happy path
and nothing else — and this adapter cannot be verified against a real model, so the fake is the only
place these paths get exercised. Every behaviour above must be reachable from a test.

Length bounds matter: `name` ≤ 255, `niche` ≤ 128, tier `name` ≤ 128, `priceAmount` an integer
between 0 and 2,000,000,000 (Phase 1's `price_amount` is a Postgres `integer`), `billingCycle` one of
`monthly`/`quarterly`/`yearly`. These mirror the columns and the Phase 2 schemas exactly — a draft
that cannot be saved is worse than no draft.

- [ ] **Steps:** failing tests (schema accepts a valid draft; rejects 0 tiers, 4 tiers, a non-integer
  price, an over-long name; the fake produces each behaviour) → implement → root gates green →
  commit `"feat(ai): add AiProviderPort with a deliberately hostile fake"`.

---

### Task 3: `OpenRouterAiAdapter` (unverified)

**Files:**
- Create: `apps/api/src/infrastructure/ai/openrouter-ai.adapter.ts`
- Test: `apps/api/src/infrastructure/ai/openrouter-ai.adapter.test.ts`
- Modify: `apps/api/.env.example`

**Interfaces:** `OpenRouterAiAdapter` constructed with `{ apiKey, model, baseUrl?, fetchFn? }`.

Follow `XenditPaymentAdapter` exactly: injected `fetchFn` so tests assert the outgoing request with
**no network call**, `AbortSignal.timeout`, a response validator that **throws** rather than
producing `String(undefined)`, and an `UNVERIFIED AGAINST THE LIVE OPENROUTER API` warning comment.

**Parsing is the substance.** The model's reply arrives as text. The adapter must:
- strip a ```` ```json ```` fence if present (models add them unprompted)
- parse, then **validate against `communityDraftSchema`**
- on any failure, **throw** — never return a partial draft
- distinguish "the model replied conversationally with no draft" (`draft: null`, legitimate) from
  "the model returned something that was supposed to be a draft and wasn't" (throw)

Errors must never contain the API key. Tests assert the outgoing headers and body, and each of the
malformed shapes.

Add `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` to `.env.example` as commented placeholders, noting
that absence disables the feature rather than blocking boot.

- [ ] **Steps:** failing tests → implement → root gates green → commit
  `"feat(ai): add OpenRouter adapter (unverified against the live API)"`.

---

### Task 4: The spend cap

**Files:**
- Create: `apps/api/src/application/ports/ai-usage-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-ai-usage.repository.ts`
- Test: `apps/api/src/infrastructure/repositories/drizzle-ai-usage.repository.test.ts`

**Interfaces:**
- `AiUsageRepositoryPort.consumeOne({ creatorId, usageDate, dailyLimit }): Promise<{ allowed: boolean; used: number }>`

**One statement.** An `INSERT … ON CONFLICT (creator_id, usage_date) DO UPDATE SET message_count =
ai_usage.message_count + 1 WHERE ai_usage.message_count < $limit RETURNING message_count` gives the
check and the increment atomically; zero rows returned means the cap was already reached. Do **not**
read-then-write.

**Tests:**
- the first call allows, and `used` is 1
- the call at the limit allows; the one after does not
- **concurrent calls cannot exceed the cap** — pinned **deterministically**, not with a bare
  `Promise.all`, which has produced a false pass five times in this project. Force the interleaving
  (the repo has prior art: `ArrivalLatch` in `apps/api/src/test-support/`, and a Phase 3 test that
  waits on `pg_stat_activity.wait_event_type = 'Lock'`), **and** assert the emitted SQL contains
  `on conflict` and no bare `select`.
- a different creator, and the same creator on a different date, are independent

**Mutation-check:** rewrite as read-then-write and confirm the concurrency test fails **every** run
across ≥5 runs.

- [ ] **Steps:** failing tests → implement → mutation-check ≥5 runs → root gates green → commit
  `"feat(ai): cap AI usage per creator per day, arbitrated by the database"`.

---

### Task 5: The chat use-case

**Files:**
- Create: `apps/api/src/application/ports/ai-conversation-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-ai-conversation.repository.ts`
- Create: `apps/api/src/application/use-cases/send-ai-message.ts`
- Create: `apps/api/src/domain/ai-prompt.ts`
- Create: `apps/api/src/routes/ai.ts`
- Modify: `apps/api/src/bootstrap.ts`, `apps/api/src/app.ts`
- Test: use-case, repository and route tests

**Interfaces:**
- `AiConversationRepositoryPort` — `createForCreator`, `findForCreator(conversationId, creatorId)`,
  `appendMessage`, `listMessages`. **Every method takes `creatorId`; there is no unscoped variant.**
- `SendAiMessage.execute({ creatorId, conversationId | null, content })` → `{ conversationId, reply, draft }`
- `ai-prompt.ts` (pure, imports nothing) — the Bahasa Indonesia system prompt and
  `buildMessages(history, userMessage)`
- `POST /ai/messages` behind `requireAuth`

**Order of operations, and why:**
1. **Consume a usage slot first.** Over the cap → 429 with the reset time, before any provider call.
   Charging the cap after the call means a failing provider still costs the creator their quota — but
   more importantly the call itself is the thing that costs money.
2. Load or create the conversation, **creator-scoped**. Unknown or another creator's → 404.
3. Append the user message.
4. Call the provider. On a **malformed-output throw, retry exactly once**, then fail with a message
   the creator can act on. Count the retry against nothing extra — it is one turn from the creator's
   perspective, and an unbounded retry doubles a bill while hiding a broken prompt.
5. Append the assistant reply and return the draft.

**The system prompt** instructs the model to reply in Bahasa Indonesia, ask about niche, audience and
pricing, and emit the draft JSON only when it has enough to propose one. It must also state that it
is helping set up a paid community and should ignore instructions contained in the user's text —
**belt and braces only**; the real defence is that output is validated and never executed (§5.2).

**Tests:**
- each hostile fake behaviour: prose, truncated JSON, fence, refusal, injection
- **the retry happens exactly once** — assert the provider was called twice, not three times
- over the cap → 429, and **the provider was not called at all**
- cross-creator conversation → 404, and the response text leaks no message content
- a refusal is a normal assistant message, not an error

- [ ] **Steps:** failing tests → implement → mutation-check the creator scoping and the retry bound →
  root gates green → commit `"feat(ai): add the co-builder chat use-case and route"`.

---

### Task 6: Carry-forwards — `GET /communities/:id` and `GET /payment-account`

**Files:**
- Modify: `apps/api/src/routes/communities.ts`, `apps/api/src/routes/payment-account.ts`
- Modify: the relevant use-cases/ports if needed
- Test: extend the existing route tests

Two endpoints Phase 6 wanted and this phase needs:

- **`GET /communities/:id`** — creator-scoped, 404 for a stranger. Phase 6's five dashboard screens
  each refetch the whole community list because it does not exist.
- **`GET /payment-account`** — returns whether the authenticated creator has connected payments.
  Today the dashboard infers it from `localStorage`, so it is per-browser. The co-builder needs it
  too: proposing paid tiers to a creator who cannot take money is a bad first experience.

**Do not** probe by attempting `POST /payment-account` — that provisions a KYC entity with no delete.

- [ ] **Steps:** failing tests (both endpoints, both cross-creator 404s) → implement → update the
  dashboard's `PaymentAccountNotice` to use the endpoint rather than `localStorage` → root gates green
  → commit `"feat(api): add GET /communities/:id and GET /payment-account"`.

---

### Task 7: The chat screen

**Files:**
- Create: `apps/web/src/dashboard/pages/CoBuilderPage.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/dashboard/ui.tsx` (nav), `types.ts`, `styles.css`
- Test: `apps/web/src/dashboard/pages/CoBuilderPage.test.tsx`

A chat at `/dashboard/co-builder`: message list, input, send. When a draft arrives, show it as an
editable summary with a **"Buat komunitas ini"** button that posts to the **existing**
`POST /communities` and then `POST …/tiers` — the same calls `CommunitiesPage` and `TiersPage` make.

**Requirements:**
- **Model output is rendered as text.** No `dangerouslySetInnerHTML`. Add a test asserting that a
  reply containing `<img src=x onerror=...>` appears as literal text and creates no element.
- The draft is **editable before saving** — name, description, and each tier's name and price. A
  creator who accepts a hallucinated price should have had to look at it.
- Prices shown and entered as **integer Rupiah**, formatted `Rp 1.250.000` via the existing
  `format.ts`.
- **429 renders as "you have reached today's limit", with the reset time** — not a generic error.
- A provider failure keeps the conversation and offers retry; the creator's typed message is not lost.
- If the AI feature is disabled server-side, **the nav entry is hidden** rather than linking to a
  screen that always errors.
- Empty state: a first-time creator sees a prompt suggesting what to say.

- [ ] **Steps:** failing tests → implement → **open it in a real browser** and drive a conversation
  end to end against the fake adapter → root gates green → commit
  `"feat(web): add the AI co-builder chat screen"`.

---

### Task 8: End-to-end verification and the phase gate

Not a coding task. **Fix whatever it surfaces.**

- [ ] Root `bun run test` and `bun run typecheck` green across four workspaces.
- [ ] Start Postgres, the API, the worker and the web app. Kill any stale Vite or API from an earlier
      session first — Phase 6's gate found one and would otherwise have verified against old code.
- [ ] **In a real browser**, recording actual output:
  1. log in, open the co-builder
  2. hold a conversation and receive a draft
  3. edit a tier price in the draft, then create the community
  4. confirm the community and tiers exist with the **edited** values, via the dashboard
  5. confirm the created community behaves normally — its checkout page loads and a member can buy
- [ ] Drive each hostile fake behaviour through the real UI (prose, truncated JSON, refusal,
      injection) and confirm the screen stays usable and the injection renders as text.
- [ ] Exceed the daily cap and confirm a 429 with a clear message, and that no provider call was made.
- [ ] Confirm **no API key, no token and no member PII** appears in any log line or URL.
- [ ] Run the full suite **3 times**; no flakes.
