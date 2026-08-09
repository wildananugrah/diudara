# Phase 4: Channel Gating — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A successful payment produces a single-use Telegram invite delivered to the member,
and a creator can remove a member's access. This is the phase that makes the product deliver
what it charges for.

**Architecture:** Payment activation writes an **outbox** row inside the existing
`PaymentActivationUnitOfWork` transaction, so the intent to invite is atomic with the payment.
A new **`apps/worker`** process claims outbox rows and performs the sends outside any
transaction, with bounded retries. A `MessagingProviderPort` has a Telegram adapter (real
gating), a Fonnte adapter (notification only), and a fake that drives every test.

**Tech Stack:** Bun, Hono, PostgreSQL 16, Drizzle, `bun:test`. New workspace `apps/worker`.

## Global Constraints

From `docs/superpowers/specs/2026-08-09-phase4-channel-gating-design.md` and inherited from
Phases 1-3. Every task's work implicitly includes these:

- **The invite send must never join the payment activation transaction.** It is an external
  HTTP call; inside `PaymentActivationUnitOfWork` a Telegram outage would roll back a paid
  activation. Activation writes an outbox row; the worker sends.
- **`grantAccess` must never silently no-op.** An adapter that cannot gate access must
  **throw**. A silent success means a paying member appears granted and is not — the worst
  failure mode in this phase.
- **An invite link is a bearer credential.** It must never appear in a log line, an error
  message, or any API response other than the notification to the member who bought it.
  Phase 2 found argon2id hashes leaking through raw error logging; Phase 3 found payer PII
  in webhook payloads. Do not regress.
- **Invite links are single-use and expiring** (`member_limit: 1` + `expire_date`). A link
  that admits a second member defeats the product's purpose.
- **Idempotency is arbitrated by the database, not a pre-check.** `channel_membership` is
  unique on `(member_id, channel_id)`; outbox rows are claimed with a conditional UPDATE.
  Phase 3 proved duplicate `activity_log` "joined" rows are producible, so the worker must
  not assume one row per activation. Phase 2 and 3 each shipped a TOCTOU that returned 500s
  — do not add a fourth.
- **Grant idempotency is a CONCURRENT property about the PROVIDER's state, not a sequential
  one about ours.** Added by the final whole-branch review; see spec §4.2 for the
  credential-lifecycle invariant and the measurements. This constraint as originally written
  above says "unique on `(member_id, channel_id)`", and the implementation satisfied that
  exactly — one row, one link recorded — while five live unrevocable invite links sat at
  Telegram behind a row whose `invite_link` was `NULL`. The unique index bounds our TABLE;
  it does not bound how many times an external provider was asked to mint a credential.
  So: the claim must also take a **mint marker and a lease in the same statement**, a link
  that cannot be recorded must be **revoked at the provider**, and a lost mint must **fail
  closed** rather than mint a replacement. And every test of it must count **links minted at
  the provider** — `expect(memberships).toHaveLength(1)` passed against the leak.
- **Bounded retries.** A permanently failing row ends as `failed` with `last_error`, never
  retrying forever.
- Secrets from the environment with no committed defaults, and the **`NODE_ENV` allowlist**
  Phase 3 established: only exactly `"development"` or `"test"` may relax a guard;
  everything else **including `undefined`** must throw. A plan that states a guard must also
  state what establishes its trigger.
- Ports-and-adapters: use-cases depend only on port interfaces.
- Drizzle only; **generated** migrations only; never edit an applied migration (`0000`-`0005`).
- Authenticated access is creator-scoped, **404 not 403**.
- Bun throughout; `bun run test` and `bun run typecheck` from the **repo root** must stay
  green. A workspace missing either script fails the whole root command — `apps/worker` must
  define both.
- Tests use `resetDatabase()` from `apps/api/src/db/test-helpers.ts` in `beforeEach`; add
  every new table to its delete list.

## Verified facts — use these as written

Researched 2026-08-09 against the providers' published documentation:

- **Telegram `createChatInviteLink`** accepts `member_limit` (1–99999) and `expire_date`.
  `member_limit: 1` makes the link single-use.
- **Telegram `banChatMember`** removes a member and prevents rejoining via any invite link.
  **`unbanChatMember` is required before a returning member can rejoin** — a banned user
  cannot be re-invited. A churned member who later re-pays must be unbanned first.
- **Meta's official WhatsApp Groups API cannot gate this product**: it has
  `DELETE /participants` and **no `POST /participants`**, and caps groups at **8
  participants** against a PRD targeting 50–2,000. Hence WhatsApp is notification-only
  (spec §2.1). Do not add WhatsApp group management in this phase.
- Conventions still in force: `c.set(...)` works on a plain `Context`; `AppError.status` is
  Hono's `ContentfulStatusCode` so `c.json(body, err.status)` needs no cast; an untyped
  `Context` inside `validate()` pollutes Hono path-param inference — the remedy is an
  explicit generic like `app.post<"/:id/revoke">(...)`, never a cast; probing an env guard
  requires `bun --no-env-file` because Bun re-loads `apps/api/.env` and silently overrides
  `env -u`.

## Honest limitation to preserve

`TelegramBotAdapter` **cannot be verified** — no bot token exists. Unlike Xendit, one is free
and instant via @BotFather, so verification should happen early. Until then its tests prove
the port contract, not the integration. Do not write tests that appear to prove otherwise,
and do not delete the warning comment it carries.

---

### Task 1: Schema — outbox and channel membership

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/test-helpers.ts`
- Test: `apps/api/src/db/schema-phase4.test.ts`

**Interfaces:**
- Produces: `outbox` and `channelMemberships` Drizzle tables; `resetDatabase()` clears both.
- `channelMemberships` is **unique on `(memberId, channelId)`** — this constraint is the
  phase's entire grant-idempotency mechanism, so it must exist in the database, not only in
  the Drizzle definition. The test asserts a real violation.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/schema-phase4.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import { channels, channelMemberships, communities, creators, members, outbox } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

async function seed() {
  const [creator] = await db
    .insert(creators)
    .values({ name: "Budi", email: `b-${Date.now()}@example.com` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas", slug: `kelas-${Date.now()}` })
    .returning();
  const [channel] = await db
    .insert(channels)
    .values({ communityId: community.id, platform: "telegram", externalGroupId: "-100123" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+628${Date.now()}`.slice(0, 15), name: "Siti" })
    .returning();
  return { channel, member };
}

describe("phase 4 schema", () => {
  it("defaults an outbox row to pending with no attempts", async () => {
    const [row] = await db
      .insert(outbox)
      .values({ eventType: "grant_access", payload: { subscriptionId: "s1" } })
      .returning();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
  });

  it("rejects a second membership for the same member and channel", async () => {
    const { channel, member } = await seed();
    await db
      .insert(channelMemberships)
      .values({ memberId: member.id, channelId: channel.id });

    let failed = false;
    try {
      await db
        .insert(channelMemberships)
        .values({ memberId: member.id, channelId: channel.id });
    } catch {
      failed = true;
    }

    // This constraint IS the grant-idempotency mechanism. If it is not in the
    // database, a retried outbox row issues a second invite link.
    expect(failed).toBe(true);
    expect((await db.select().from(channelMemberships)).length).toBe(1);
  });

  it("defaults a membership to active", async () => {
    const { channel, member } = await seed();
    const [row] = await db
      .insert(channelMemberships)
      .values({ memberId: member.id, channelId: channel.id })
      .returning();
    expect(row.status).toBe("active");
    expect(row.revokedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && bun test src/db/schema-phase4.test.ts
```

Expected: FAIL — `outbox` and `channelMemberships` are not exported.

- [ ] **Step 3: Implement**

Append to `apps/api/src/db/schema.ts`:

```ts
/**
 * Transactional outbox. A payment activation writes a row here in the SAME
 * transaction as the subscription update, so the intent to invite is atomic
 * with the payment and can never be lost. The worker sends outside any
 * transaction — a Telegram outage must delay an invite, never roll back a
 * payment.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: varchar("last_error", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("outbox_claim_idx").on(table.status, table.nextAttemptAt)]
);

/**
 * Who currently has access to which channel.
 * UNIQUE (member_id, channel_id) is the grant-idempotency mechanism: a retried
 * outbox row must not issue a second invite link, and the database arbitrates
 * that, not a pre-check.
 */
export const channelMemberships = pgTable(
  "channel_membership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    inviteLink: varchar("invite_link", { length: 512 }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("channel_membership_member_channel_unique").on(table.memberId, table.channelId),
    index("channel_membership_channel_idx").on(table.channelId),
  ]
);
```

Add `index` and `uniqueIndex` to the `drizzle-orm/pg-core` import if absent.

In `test-helpers.ts`, import both tables and delete them **before** `members`/`channels`
(they reference those): `channelMemberships` first, then `outbox` (no FKs, order free).

Generate and apply:

```bash
bun run db:generate && bun run db:migrate
```

- [ ] **Step 4: Verify and commit**

```bash
bun test src/db/schema-phase4.test.ts
cd ../.. && bun run test && bun run typecheck
git add apps/api/src/db apps/api/drizzle
git commit -m "feat(db): add outbox and channel_membership tables"
```

---

### Task 2: `MessagingProviderPort`, fake adapter, and the capability boundary

**Files:**
- Create: `apps/api/src/application/ports/messaging-provider.port.ts`
- Create: `apps/api/src/infrastructure/messaging/fake-messaging.adapter.ts`
- Modify: `apps/api/src/application/errors.ts` (add `UnsupportedOperationError`)
- Test: `apps/api/src/infrastructure/messaging/fake-messaging.adapter.test.ts`

**Interfaces:**
- `MessagingProviderPort` — `platform`, `capabilities()`, `grantAccess`, `revokeAccess`,
  `notify`
- `UnsupportedOperationError` (409)
- `FakeMessagingAdapter` — constructed with `{ canGateAccess }`; records every call

**The capability boundary is the point of this task.** WhatsApp cannot gate access (spec
§2.1). Expressing that as `capabilities().canGateAccess` plus a **throw** — rather than a
comment or a silent no-op — is what stops a paying member from appearing granted when they
are not.

- [ ] **Step 1: Write the port, the error, and the failing test**

Create `apps/api/src/application/ports/messaging-provider.port.ts`:

```ts
export interface MessagingCapabilities {
  /**
   * Whether this provider can actually add and remove members from a group.
   * False for WhatsApp: Meta's official Groups API has no POST /participants
   * and caps groups at 8 members, and unofficial gateways would risk the
   * CREATOR's account. See spec §2.1.
   */
  canGateAccess: boolean;
}

export interface GrantAccessInput {
  externalGroupId: string;
  memberWhatsappNumber: string;
}

export interface RevokeAccessInput {
  externalGroupId: string;
  /** Provider-specific member identifier recorded at grant time. */
  externalMemberId: string;
}

export interface NotifyInput {
  toWhatsappNumber: string;
  message: string;
}

export interface MessagingProviderPort {
  readonly platform: string;
  capabilities(): MessagingCapabilities;
  /**
   * Issues a single-use, expiring invite. MUST throw UnsupportedOperationError
   * when capabilities().canGateAccess is false — a silent no-op would leave a
   * paying member believing they were granted access.
   */
  grantAccess(input: GrantAccessInput): Promise<{ inviteLink: string }>;
  revokeAccess(input: RevokeAccessInput): Promise<void>;
  notify(input: NotifyInput): Promise<void>;
}
```

Add to `apps/api/src/application/errors.ts`:

```ts
export class UnsupportedOperationError extends AppError {
  constructor(message = "operation not supported by this provider") {
    super(message, 409);
  }
}
```

Create `apps/api/src/infrastructure/messaging/fake-messaging.adapter.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { FakeMessagingAdapter } from "./fake-messaging.adapter";
import { UnsupportedOperationError } from "../../application/errors";

describe("FakeMessagingAdapter", () => {
  it("issues an invite and records the call when gating is supported", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
    const { inviteLink } = await adapter.grantAccess({
      externalGroupId: "-100123",
      memberWhatsappNumber: "+6281234567890",
    });

    expect(inviteLink).toContain("http");
    expect(adapter.grants.length).toBe(1);
    expect(adapter.grants[0].externalGroupId).toBe("-100123");
  });

  it("issues a DISTINCT link per grant, so a link is never reused", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
    const a = await adapter.grantAccess({ externalGroupId: "-1", memberWhatsappNumber: "+621" });
    const b = await adapter.grantAccess({ externalGroupId: "-1", memberWhatsappNumber: "+622" });
    expect(a.inviteLink).not.toBe(b.inviteLink);
  });

  it("THROWS rather than no-opping when gating is unsupported", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    await expect(
      adapter.grantAccess({ externalGroupId: "-1", memberWhatsappNumber: "+621" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(adapter.grants.length).toBe(0);
  });

  it("throws on revoke when gating is unsupported", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    await expect(
      adapter.revokeAccess({ externalGroupId: "-1", externalMemberId: "m1" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("notifies regardless of gating capability", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    await adapter.notify({ toWhatsappNumber: "+6281234567890", message: "halo" });
    expect(adapter.notifications.length).toBe(1);
  });

  it("can be told to fail, so callers' retry paths are testable", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
    adapter.failNextGrant = true;
    await expect(
      adapter.grantAccess({ externalGroupId: "-1", memberWhatsappNumber: "+621" })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/api && bun test src/infrastructure/messaging
```

Expected: FAIL — the adapter module does not exist.

- [ ] **Step 3: Implement**

Create `apps/api/src/infrastructure/messaging/fake-messaging.adapter.ts`:

```ts
import { UnsupportedOperationError } from "../../application/errors";
import type {
  GrantAccessInput,
  MessagingCapabilities,
  MessagingProviderPort,
  NotifyInput,
  RevokeAccessInput,
} from "../../application/ports/messaging-provider.port";

/** In-memory messaging provider for tests and local development. */
export class FakeMessagingAdapter implements MessagingProviderPort {
  readonly platform: string;
  readonly grants: GrantAccessInput[] = [];
  readonly revocations: RevokeAccessInput[] = [];
  readonly notifications: NotifyInput[] = [];
  failNextGrant = false;

  private readonly canGate: boolean;
  private counter = 0;

  constructor(config: { platform: string; canGateAccess: boolean }) {
    this.platform = config.platform;
    this.canGate = config.canGateAccess;
  }

  capabilities(): MessagingCapabilities {
    return { canGateAccess: this.canGate };
  }

  private assertCanGate(operation: string): void {
    if (!this.canGate) {
      throw new UnsupportedOperationError(
        `${this.platform} cannot ${operation}: this provider does not support access gating`
      );
    }
  }

  async grantAccess(input: GrantAccessInput): Promise<{ inviteLink: string }> {
    this.assertCanGate("grant access");
    if (this.failNextGrant) {
      this.failNextGrant = false;
      throw new Error("fake messaging provider: grantAccess failed");
    }
    this.grants.push(input);
    this.counter += 1;
    return { inviteLink: `https://fake-invite.local/${this.platform}/${this.counter}` };
  }

  async revokeAccess(input: RevokeAccessInput): Promise<void> {
    this.assertCanGate("revoke access");
    this.revocations.push(input);
  }

  async notify(input: NotifyInput): Promise<void> {
    this.notifications.push(input);
  }
}
```

- [ ] **Step 4: Verify and commit**

```bash
bun test src/infrastructure/messaging
cd ../.. && bun run typecheck
git add apps/api/src/application apps/api/src/infrastructure/messaging
git commit -m "feat(messaging): add MessagingProviderPort with a capability boundary"
```

---

### Task 3: Telegram and Fonnte adapters

**Files:**
- Create: `apps/api/src/infrastructure/messaging/telegram-bot.adapter.ts`
- Create: `apps/api/src/infrastructure/messaging/fonnte-whatsapp.adapter.ts`
- Test: `apps/api/src/infrastructure/messaging/telegram-bot.adapter.test.ts`
- Test: `apps/api/src/infrastructure/messaging/fonnte-whatsapp.adapter.test.ts`
- Modify: `apps/api/.env.example`

**Interfaces:**
- `TelegramBotAdapter` — `{ botToken, baseUrl?, fetchFn?, inviteTtlSeconds? }`,
  `canGateAccess: true`
- `FonnteWhatsAppAdapter` — `{ apiToken, baseUrl?, fetchFn? }`, `canGateAccess: false`

Both inject `fetchFn` so tests assert the outgoing request with **no network call**, the same
pattern `XenditPaymentAdapter` uses.

**Requirements the tests must pin:**
- `createChatInviteLink` is called with `member_limit: 1` **and** an `expire_date` in the
  future. Both matter: without the limit a link admits many members; without the expiry a
  leaked unused link works forever.
- `banChatMember` is used for revoke, and **`unbanChatMember` is called before a re-grant**
  for a previously-revoked member (Telegram cannot re-invite a banned user).
- Errors never include the bot token or the Fonnte API token.
- Fonnte's `grantAccess`/`revokeAccess` throw `UnsupportedOperationError`; `notify` works.
- A non-2xx or an unrecognised response body **throws** rather than returning a bogus link —
  Phase 3 found `String(body.id)` yielding the literal `"undefined"`; do not repeat it.

Write the tests first, assert the outgoing headers and body, then implement. Both adapters
carry an `UNVERIFIED AGAINST THE LIVE API` warning comment explaining that the tests prove
the port contract only. Add `TELEGRAM_BOT_TOKEN` and `FONNTE_API_TOKEN` to `.env.example`
as commented placeholders, documenting that absence selects the fake adapter and that the
`NODE_ENV` allowlist applies.

- [ ] **Steps:** failing tests → implement → `bun test src/infrastructure/messaging` →
  root `bun run test` and `bun run typecheck` → commit
  `"feat(messaging): add Telegram and Fonnte adapters (unverified against live APIs)"`.

---

### Task 4: Write the outbox row inside the activation transaction

**Files:**
- Create: `apps/api/src/application/ports/outbox-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-outbox.repository.ts`
- Modify: `apps/api/src/application/ports/payment-activation-unit-of-work.port.ts`
- Modify: `apps/api/src/infrastructure/repositories/drizzle-payment-activation.unit-of-work.ts`
- Modify: `apps/api/src/application/use-cases/handle-payment-webhook.ts`
- Test: `apps/api/src/routes/webhooks.test.ts` (extend)

**Interfaces:**
- `OutboxRepositoryPort` — `enqueue({ eventType, payload })`, `claimBatch(limit)`,
  `markSent(id)`, `markFailed(id, error, nextAttemptAt)`, `markPermanentlyFailed(id, error)`
- The unit of work's `repositories` gains `outbox`.

**This is the atomicity requirement.** The `enqueue` must happen inside the same transaction
as the activation, and the assertions must prove both directions:

- a successful activation leaves exactly **one** pending `outbox` row
- a **failed** activation leaves **zero** outbox rows (the transaction rolled it back), and a
  subsequent retry then succeeds — Phase 3 already has a forced-failure test for the
  webhook_event rollback; extend it to cover the outbox
- a **replayed** webhook produces **one** outbox row, not two

That last one is the trap Phase 3's own idempotency test fell into: asserting only that
activation happened is true whether or not replay protection works. Assert the **count**.

- [ ] **Steps:** failing tests → implement → mutation-check by removing the `enqueue` call
  (a test must go red) and by moving it outside the transaction (the rollback test must go
  red) → root gates green → commit
  `"feat(payments): enqueue a grant_access outbox row atomically with activation"`.

---

### Task 5: `apps/worker` and `ProcessOutbox`

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/main.ts`
- Create: `apps/api/src/application/use-cases/process-outbox.ts`
- Create: `apps/api/src/application/use-cases/grant-channel-access.ts`
- Create: `apps/api/src/application/ports/channel-membership-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-channel-membership.repository.ts`
- Test: `apps/api/src/application/use-cases/process-outbox.test.ts`
- Test: `apps/api/src/application/use-cases/grant-channel-access.test.ts`

**Interfaces:**
- `GrantChannelAccess.execute({ subscriptionId })` — resolves the member and the community's
  channels; for each channel whose adapter reports `canGateAccess`, grants, records a
  `channel_membership`, notifies via WhatsApp, and writes an `activity_log` entry.
- `ProcessOutbox.execute()` — claims a batch, dispatches by `eventType`, marks sent or
  schedules a retry with exponential backoff, and marks `failed` past a max attempt count.
- `apps/worker` polls on an interval and shuts down cleanly on SIGTERM.

**Requirements the tests must pin — this is the most correctness-sensitive task:**

- **Claim race.** Two concurrent `claimBatch` calls must not both return the same row.
  Implement with a conditional UPDATE (`... WHERE status = 'pending' AND next_attempt_at <= now()`
  … `RETURNING`), or `FOR UPDATE SKIP LOCKED`. Prove it with a real concurrent test, **and**
  pin the mechanism the way Phase 3 learned to: a racing test alone is a probabilistic
  detector — a select-then-update mutant survived Phase 3's full suite. Assert the emitted
  SQL or use a deterministic interleaving.
- **Grant idempotency.** Processing the same `grant_access` payload twice must produce **one**
  membership and **one** invite link, arbitrated by the unique constraint.
- **A notify-only channel must not silently skip.** A community with only a WhatsApp channel
  and no Telegram channel is a real configuration; decide and test the behaviour explicitly
  (recommended: the outbox row succeeds, the member is notified that the creator will add
  them manually, and an `activity_log` entry records that no automated gating was possible).
  What must **not** happen is a silent success that looks like access was granted.
- **Bounded retries.** After the max attempts a row is `failed` with `last_error`, and is not
  claimed again.
- **Invite links never leak.** Assert no log line or error message contains an invite link.

- [ ] **Steps:** failing tests → implement → mutation-check the claim guard, the idempotency
  constraint reliance, and the retry bound → root gates green → commit
  `"feat(worker): add apps/worker and outbox-driven channel access granting"`.

---

### Task 6: `RevokeChannelAccess` and the manual creator endpoint

**Files:**
- Create: `apps/api/src/application/use-cases/revoke-channel-access.ts`
- Create: `apps/api/src/routes/memberships.ts`
- Modify: `apps/api/src/bootstrap.ts`, `apps/api/src/app.ts`
- Test: `apps/api/src/routes/memberships.test.ts`

**Interfaces:**
- `RevokeChannelAccess.execute({ communityId, creatorId, memberId })`
- `POST /communities/:communityId/members/:memberId/revoke`, behind `requireAuth`

Revocation is **synchronous**, not outboxed: a creator removing someone expects to know
whether it worked, and there is no transaction to protect.

**Requirements:**
- Creator-scoped: a stranger's token gets **404**, and the membership is genuinely unchanged.
- A member with no active membership → 404.
- A notify-only channel → the operation reports that it could not be automated rather than
  claiming success.
- `channel_membership.status` becomes `revoked` with `revokedAt` set; `activity_log` records it.
- Phase 5 will call this same use-case from churn detection — keep it free of HTTP concerns.

- [ ] **Steps:** failing tests → implement → mutation-check the creator scoping (a test must
  go red) → root gates green → commit
  `"feat(gating): add channel access revocation and the creator endpoint"`.

---

### Task 7: Carry-forward fixes from Phase 3

**Files:** as needed across `apps/api/src`.

Three items Phase 3's reviews deferred to this phase, all recorded in its final report:

1. **`POST /payment-account`'s pre-provider-call window.** Simultaneous requests mint orphaned
   Xendit sub-accounts (30 concurrent → 30 accounts, 29 orphaned; sequential → 1). The DB
   TOCTOU is closed; the external side effect is not. Pick one of the three written-up
   options — **recommended: claim the row with a sentinel value before calling the provider,
   then replace it with the real id.** Note a sentinel changes what `StartCheckout` reads, so
   `StartCheckout` must treat a sentinel as "not yet payable" and 409.
2. **`markPaid`'s zero-row path** treats any non-`pending` status as "already settled",
   including `failed`. Distinguish them: an already-`success` transaction is an idempotent
   no-op, but a `failed` one arriving with a genuine payment must not be silently swallowed
   as a duplicate. The read already has the status in hand.
3. **Duplicate pending subscriptions.** A double-submit creates two; nothing decides which is
   authoritative. This phase is the first to act on one, so decide the rule and enforce it.
   **Recommended:** when activating, if the member already has an `active` subscription for
   the same tier, treat the second as superseded (mark it `cancelled`) rather than granting
   twice.

Each needs a test that fails before the fix. Commit separately per item.

---

### Task 8: End-to-end verification and the phase gate

**Files:** none necessarily — this is a verification task. Fix whatever it surfaces.

- [ ] `bun run test` and `bun run typecheck` green from the repo root, across all four
  workspaces.
- [ ] Start Postgres, the API, the **worker**, and the web app. Then, recording actual output:
  1. sign up a creator, `POST /payment-account`
  2. create a community, an active tier, and a **Telegram** channel with an
     `external_group_id`
  3. open `/c/:slug`, complete checkout
  4. POST the webhook with the correct callback token
  5. confirm an `outbox` row appears, the worker claims it, a `channel_membership` is
     created, an invite link is issued, and a WhatsApp notification is recorded
  6. confirm the status page flips to active
  7. `POST .../revoke` and confirm the membership becomes `revoked`
- [ ] **Replay the webhook** and confirm: one membership, one invite, one `activity_log`
  "joined", one outbox row.
- [ ] Confirm **no invite link appears in any log line** from the whole run.
- [ ] Run the full suite **5 times** and confirm no flakes — Phase 3 had an unreproducible
  failure that turned out to be a probabilistic test, and this phase adds a worker with
  concurrent claims.

---

### Task 9: Final whole-branch review fixes (added 2026-08-09)

The final gate before merging `phase-4-gating` into `main` returned **"No — with fixes"**.
All findings were reproduced independently before being fixed, and every fix has a test that
failed before it and passes after. Report:
`.superpowers/sdd/2026-08-09-phase4-channel-gating/final-fix-report.md`.

**What this task changed about the PLAN itself, and why it is recorded here rather than
quietly fixed:**

> **Grant idempotency was specified as a SEQUENTIAL property and needed to be a CONCURRENT
> one.**

Spec §4.1 and this plan's Global Constraints both stated idempotency as a property of
`channel_membership`'s unique `(member_id, channel_id)` index: process the same payload
twice, get one membership row and one link. The implementation satisfied that literally, and
the test suite proved it — with a test named "issues ONE membership and ONE invite link when
the same payload is processed twice", which exercised the sequential, successful path and
passed.

Neither document said anything about how many times the **provider** may be asked to mint,
which is the thing that actually matters, because an invite link is a bearer credential that
exists at Telegram whether or not our write succeeded. Under a failing `recordGrant` the
bounded retry minted a fresh link every attempt: **5 live single-use links, one membership
row, `invite_link = NULL`**, none recorded and therefore none revocable. Two concurrent
grants for one `(member, channel)` produced **2**, both delivered.

Three lessons, worth carrying into Phase 5:

1. **An idempotency requirement has to name the resource it bounds.** "One membership row"
   and "one credential at the provider" are different claims, and the cheap one to test is
   the one that does not matter.
2. **A property about concurrency must be tested with the interleaving FORCED.** The
   two-concurrent-grants test was written first as two bare `Promise.all` calls and **passed
   against the broken code**, because the scheduler happened to order them safely. It only
   reproduced once a barrier held both callers inside the mint window. This repeats a lesson
   already recorded in `drizzle-outbox.repository.test.ts` for `claimBatch` — a racing test
   is a smoke check, never a guard.
3. **Where an external call and a local write must agree, the plan owes a rule for the
   window between them.** This plan said "the row is claimed before the provider is called",
   which handles a crash before the call and says nothing about a failure after it. That gap
   is where the leak lived, and closing it needed a provider capability
   (`revokeInviteLink`) that no task had asked for.

**Fixes, in the commits that made them:**

- **C1 (critical)** — the credential leak above. `revokeInviteLink` added to the port and
  both real adapters; `link_minted_at` + `mint_lease_until` written in the same statement as
  the claim; `recordGrant` made conditional and reporting. Live links: 5 → 0 under the retry
  bound, 2 → 1 under forced concurrency.
- **I1** — `StartCheckout` now 409s before the invoice when the member already holds the
  tier. It used to charge them, then `supersede` the subscription with no notification of any
  kind.
- **I2** — the stale-processing clock was per-batch, so a slow pass invited a double claim.
  Per-row heartbeat plus a bounded pass that releases what it did not reach.
- **I3** — a failed platform removal is now a `revoke_access` outbox row the worker retries,
  rather than an `automated: false` that nothing ever acted on. Phase 5's churn job depends
  on this.
- **Minors** — log-guard symmetry (`redactLinks(safeErrorSummary(err))` in all three
  places), a length cap on the inbound `invite_link`, the chat id matched (not just logged)
  on the join write, and `reclaimStaleProcessing` keeping the previous diagnostic instead of
  overwriting it.

- [x] Full suite and typecheck green from the repo root; suite run **3×** with no flakes
  (793 pass / 0 fail: api 721, shared 44, worker 19, web 9).
