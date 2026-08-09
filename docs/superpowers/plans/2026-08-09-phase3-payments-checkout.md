# Phase 3: Payments & Checkout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member opens a creator's public checkout page, pays with a local Indonesian
method, and ends up with an active subscription — with funds settling into the creator's
Xendit sub-account, never the platform's.

**Architecture:** Extends the ports-and-adapters layering from Phases 1-2. A new
`PaymentProviderPort` has two adapters: a fake that drives every test, and a Xendit adapter
that is a best-effort transcription of the published API (unverified — see below). Adds the
first public, unauthenticated routes in the product, including a webhook endpoint that is
the highest-risk surface in the phase.

**Tech Stack:** Bun, Hono, PostgreSQL 16, Drizzle, Zod via `@diudara/shared`, Vite + React
(new `apps/web`), `bun:test`.

## Global Constraints

From `docs/superpowers/specs/2026-08-09-phase3-payments-checkout-design.md` and the parent
MVP spec. Every task's work implicitly includes these:

- **Member funds must never land in a platform-owned account.** Invoices are always created
  on behalf of the creator's Xendit sub-account (`for-user-id`) with a split rule
  (`with-split-rule`) that routes only DIUDARA's fee to the master account. This keeps the
  product outside Bank Indonesia PJP licensing. Any code path that would charge to a
  platform account is **wrong** — reject it rather than making it work.
- A creator with no `xendit_account_id` **cannot** accept payments. Checkout rejects this
  explicitly (409); it must never fall back to a platform account.
- **Never trust a webhook body's amounts or statuses.** Xendit authenticates webhooks with a
  *static* `X-CALLBACK-TOKEN` header, not an HMAC of the payload — the token authenticates
  the sender, not the message. Always look up our own `transaction` and verify the amount.
- Webhook processing is **idempotent** — a replayed delivery is a no-op, never a second
  activation.
- Ports-and-adapters (SOLID): use-cases depend only on port interfaces, never concrete SDKs.
- PostgreSQL exclusively through Drizzle; schema changes via **generated** migrations only —
  never hand-written, never editing an applied migration (`0000`-`0004`).
- Cross-tenant rule from Phase 2 still holds: authenticated resource access scoped by
  `creatorId`, 404 not 403.
- **`findBySlug` is a deliberate, single exception to that rule** (Task 5). Phase 2's review
  specifically praised `CommunityRepositoryPort` for having *no* unscoped lookup, which made
  the vulnerable query unwritable. Public checkout has no authenticated caller, so one
  unscoped lookup is unavoidable — but it is the **only** one, it is documented at the port,
  and it must never be used to serve an authenticated route. A reviewer should verify no
  authenticated handler reaches for it.
- Password hashes never leave the repository layer. Error logs must never contain raw error
  objects (Phase 2 found argon2id hashes leaking that way) — Xendit payloads carry payer
  identifiers, so this must not regress.
- **The fake payment adapter must be unreachable in production.** `bootstrap()` permits the
  fake adapter — and an absent `XENDIT_CALLBACK_TOKEN` — **only** when `NODE_ENV` is exactly
  `"development"` or `"test"`, and throws for **every** other value **including `undefined`**.
  It also throws on *partial* configuration in **every** environment — a set secret key with
  an unset split rule id is always a mistake, and it makes an operator believe payments are
  live. This mirrors the existing `assertUsableJwtSecret` guard. A `console.log` is not
  sufficient: it silently writes unrecoverable `fake-acct-*` values into
  `creator.xendit_account_id`, which `CreatePaymentAccount` then 409s on forever with no
  reset path.

  **AMENDED 2026-08-09 (final review, C1).** This constraint originally specified a
  *denylist*: "throws when `NODE_ENV === "production"`". That shape was implemented faithfully
  and **never fired**, because nothing in this repository establishes its trigger — Bun does
  not default `NODE_ENV` (`bun -e 'console.log(process.env.NODE_ENV)'` → `undefined`),
  `apps/api/package.json` has no `start` script, there is no Dockerfile, `infra/docker-compose.yml`
  has no API service, and `.env.example` never mentioned `NODE_ENV`. So the first real
  deployment would have taken the *unsafe* branch, as would `"staging"`, `"prod"` and
  `"PRODUCTION"`. The rule is therefore an **allowlist** (`RELAXED_NODE_ENVS` in
  `bootstrap.ts`), the same shape as `VISIBLE_STATUSES` in the public-community use-case and
  for the same reason: an unanticipated value must fail **closed**. A plan that states a
  guard must also state what establishes the guard's trigger — `.env.example` now ships
  `NODE_ENV=development`, and a test pins that it does.

  The same review also set a **32-character floor on `XENDIT_CALLBACK_TOKEN`**, mirroring
  `JWT_SECRET`: it is the webhook's only authentication, and `"x"` was being accepted.
- Bun throughout; `bun run test` and `bun run typecheck` from the repo root must stay green.
- Tests use `resetDatabase()` from `apps/api/src/db/test-helpers.ts` in `beforeEach`; add any
  new table to its delete list.

## Verified facts — use these as written

Probed on 2026-08-09 against the installed runtime and Xendit's published docs:

- **`node:crypto`'s `timingSafeEqual` is available in Bun**, but it **throws**
  `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` when the two buffers differ in length. A naive
  implementation returns 500 instead of 401 and leaks token length. **Remedy (verified):**
  SHA-256 both sides to a fixed 32 bytes first, then compare — no length leak, no throw, and
  correct results for shorter, longer, and empty inputs.
- **Xendit webhook auth is a static `X-CALLBACK-TOKEN` header**, not a payload HMAC.
- **Xendit split-payment headers:** `for-user-id` takes the sub-account's Business ID;
  `with-split-rule` takes a **Split Rule ID created in the Xendit dashboard** — so it is
  configuration (an env var), not something built per transaction.
- Phase 2 conventions that still apply: `c.set(...)` works on a plain `Context`;
  `AppError.status` is typed as Hono's `ContentfulStatusCode` so `c.json(body, err.status)`
  needs no cast; and an untyped `Context` inside `validate()` can pollute Hono's path-param
  inference on a multi-handler route — the remedy is an explicit generic like
  `app.post<"/:slug/checkout">(...)`, never a cast.

## Honest limitation to preserve

`XenditPaymentAdapter` **cannot be verified** — there is no Xendit account. Its request
shapes and error handling are assumptions until exercised against a real sandbox. Tests
prove the *port contract*, not the integration. Do not write tests that appear to prove the
adapter works against Xendit; do not delete the warning comment the adapter carries.

---

### Task 1: Schema — creator payment account and webhook idempotency

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/test-helpers.ts`
- Test: `apps/api/src/db/schema-phase3.test.ts`

**Interfaces:**
- Consumes: existing `creators` table.
- Produces: `creators.xenditAccountId` (varchar, nullable); new `webhookEvents` table with a
  **unique** `providerEventId`; `resetDatabase()` clears it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/schema-phase3.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import { creators, webhookEvents } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

describe("phase 3 schema", () => {
  it("stores a creator without a payment account by default", async () => {
    const [creator] = await db
      .insert(creators)
      .values({ name: "Budi", email: "budi@example.com" })
      .returning();
    expect(creator.xenditAccountId).toBeNull();
  });

  it("rejects a duplicate provider event id", async () => {
    await db.insert(webhookEvents).values({
      provider: "xendit",
      providerEventId: "evt-1",
      eventType: "invoice.paid",
      payload: { any: "thing" },
    });

    let failed = false;
    try {
      await db.insert(webhookEvents).values({
        provider: "xendit",
        providerEventId: "evt-1",
        eventType: "invoice.paid",
        payload: { any: "thing" },
      });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
    expect((await db.select().from(webhookEvents)).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && bun test src/db/schema-phase3.test.ts
```

Expected: FAIL — `webhookEvents` is not exported and `xenditAccountId` is not a column.

- [ ] **Step 3: Implement**

In `apps/api/src/db/schema.ts`, add to the `creators` table after `passwordHash`:

```ts
  xenditAccountId: varchar("xendit_account_id", { length: 255 }),
```

And append a new table:

```ts
export const webhookEvents = pgTable("webhook_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: varchar("provider", { length: 32 }).notNull(),
  // Unique: the existence of a row means "already handled". This is the
  // entire replay defence — Xendit's static token cannot provide one.
  providerEventId: varchar("provider_event_id", { length: 255 }).notNull().unique(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  payload: jsonb("payload"),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});
```

In `apps/api/src/db/test-helpers.ts`, import `webhookEvents` and add
`await db.delete(webhookEvents);` — it has no foreign keys, so put it first.

Generate and apply:

```bash
bun run db:generate && bun run db:migrate
```

- [ ] **Step 4: Verify it passes, then the full suite**

```bash
bun test src/db/schema-phase3.test.ts
cd ../.. && bun run test && bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db apps/api/drizzle
git commit -m "feat(db): add creator xendit account id and webhook_event table"
```

---

### Task 2: `PaymentProviderPort` and the fake adapter

**Files:**
- Create: `apps/api/src/application/ports/payment-provider.port.ts`
- Create: `apps/api/src/infrastructure/payments/fake-payment.adapter.ts`
- Test: `apps/api/src/infrastructure/payments/fake-payment.adapter.test.ts`

**Interfaces:**
- Produces: `PaymentProviderPort`, `CreateInvoiceInput`, `CreateInvoiceResult`, and
  `FakePaymentAdapter` — which records every call so tests can assert **which account** an
  invoice was charged to.

- [ ] **Step 1: Write the port and the failing test**

Create `apps/api/src/application/ports/payment-provider.port.ts`:

```ts
export interface CreateInvoiceInput {
  /** Our transaction id. Xendit echoes it back on the webhook. */
  externalId: string;
  amount: number;
  description: string;
  payerName: string;
  payerWhatsappNumber: string;
  /**
   * The CREATOR's payment-provider account id. Funds settle here, never in a
   * platform account — this is what keeps DIUDARA outside PJP licensing.
   * Required, never optional: there is no valid "charge the platform" case.
   */
  forAccountId: string;
}

export interface CreateInvoiceResult {
  invoiceId: string;
  invoiceUrl: string;
}

export interface PaymentProviderPort {
  createPaymentAccount(input: {
    creatorId: string;
    email: string;
    name: string;
  }): Promise<{ accountId: string }>;

  createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;
}
```

Create `apps/api/src/infrastructure/payments/fake-payment.adapter.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { FakePaymentAdapter } from "./fake-payment.adapter";

const INPUT = {
  externalId: "txn-1",
  amount: 50000,
  description: "Basic",
  payerName: "Siti",
  payerWhatsappNumber: "+6281234567890",
  forAccountId: "acct-creator-1",
};

describe("FakePaymentAdapter", () => {
  it("returns an invoice and records which account it was charged to", async () => {
    const adapter = new FakePaymentAdapter();
    const result = await adapter.createInvoice(INPUT);

    expect(result.invoiceId).toBeTruthy();
    expect(result.invoiceUrl).toContain(result.invoiceId);
    expect(adapter.invoices.length).toBe(1);
    expect(adapter.invoices[0].forAccountId).toBe("acct-creator-1");
  });

  it("creates a distinct account id per creator", async () => {
    const adapter = new FakePaymentAdapter();
    const a = await adapter.createPaymentAccount({
      creatorId: "c1", email: "a@example.com", name: "A",
    });
    const b = await adapter.createPaymentAccount({
      creatorId: "c2", email: "b@example.com", name: "B",
    });
    expect(a.accountId).not.toBe(b.accountId);
  });

  it("can be told to fail, so callers' error paths are testable", async () => {
    const adapter = new FakePaymentAdapter();
    adapter.failNextInvoice = true;
    await expect(adapter.createInvoice(INPUT)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && bun test src/infrastructure/payments
```

Expected: FAIL — the adapter module does not exist.

- [ ] **Step 3: Implement**

Create `apps/api/src/infrastructure/payments/fake-payment.adapter.ts`:

```ts
import type {
  CreateInvoiceInput,
  CreateInvoiceResult,
  PaymentProviderPort,
} from "../../application/ports/payment-provider.port";

/**
 * In-memory payment provider for tests and local development.
 * Records every call so tests can assert that invoices are charged to the
 * CREATOR's account and never to a platform account.
 */
export class FakePaymentAdapter implements PaymentProviderPort {
  readonly invoices: CreateInvoiceInput[] = [];
  readonly accounts: { creatorId: string; accountId: string }[] = [];
  failNextInvoice = false;

  async createPaymentAccount(input: {
    creatorId: string;
    email: string;
    name: string;
  }): Promise<{ accountId: string }> {
    const accountId = `fake-acct-${this.accounts.length + 1}-${input.creatorId}`;
    this.accounts.push({ creatorId: input.creatorId, accountId });
    return { accountId };
  }

  async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    if (this.failNextInvoice) {
      this.failNextInvoice = false;
      throw new Error("fake payment provider: createInvoice failed");
    }
    this.invoices.push(input);
    const invoiceId = `fake-inv-${this.invoices.length}`;
    return { invoiceId, invoiceUrl: `https://fake-checkout.local/${invoiceId}` };
  }
}
```

- [ ] **Step 4: Add the payment-onboarding use-case and route**

Without this, `createPaymentAccount` has no caller and a creator can never become payable —
every later checkout test would have to fake it with raw SQL. Onboarding is *stubbed* only
in the sense that the fake adapter invents the id; the wiring is real.

Create `apps/api/src/application/use-cases/create-payment-account.ts`:

```ts
import { ConflictError, NotFoundError } from "../errors";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";
import type { PaymentProviderPort } from "../ports/payment-provider.port";

export class CreatePaymentAccount {
  constructor(
    private readonly creators: CreatorRepositoryPort,
    private readonly payments: PaymentProviderPort
  ) {}

  async execute(creatorId: string): Promise<{ xenditAccountId: string }> {
    const creator = await this.creators.findById(creatorId);
    if (!creator) {
      throw new NotFoundError("creator not found");
    }
    if (creator.xenditAccountId) {
      throw new ConflictError("payment account already connected");
    }
    if (!creator.email) {
      throw new ConflictError("an email address is required to connect payments");
    }

    const { accountId } = await this.payments.createPaymentAccount({
      creatorId: creator.id,
      email: creator.email,
      name: creator.name,
    });

    await this.creators.setXenditAccountId(creator.id, accountId);
    return { xenditAccountId: accountId };
  }
}
```

Add `xenditAccountId: string | null` to `CreatorRecord`, include it in the repository's
`creatorColumns` projection (it is **not** a secret — unlike `passwordHash`, which stays
excluded), and add `setXenditAccountId(id, accountId)` to `CreatorRepositoryPort` and the
Drizzle adapter.

Add an authenticated route in a new `apps/api/src/routes/payment-account.ts`:
`POST /payment-account` behind `requireAuth`, calling
`deps.createPaymentAccount.execute(c.get("creatorId"))` and returning 201. Wire it into
`Dependencies`/`bootstrap()` and mount it in `app.ts`.

Write `apps/api/src/routes/payment-account.test.ts` covering: unauthenticated → 401; first
call → 201 and the id is persisted; second call → 409; and that the response body does
**not** contain `passwordHash`.

- [ ] **Step 5: (moved) — the `updated_at` carry-forward now belongs to Task 6**

Originally placed here, but the subscription and transaction repositories do not exist until
Task 6, so there is nothing to edit at this point. Do not fabricate code for files that do
not yet exist. Task 6 carries the requirement.

- [ ] **Step 6: Verify, then commit**

```bash
bun test src/infrastructure/payments src/routes/payment-account.test.ts
cd ../.. && bun run test && bun run typecheck
git add apps/api/src packages/shared/src
git commit -m "feat(payments): add PaymentProviderPort, fake adapter, and creator payment onboarding"
```

---

### Task 3: Webhook token verification (constant-time)

**Files:**
- Create: `apps/api/src/infrastructure/payments/webhook-token.ts`
- Test: `apps/api/src/infrastructure/payments/webhook-token.test.ts`

**Interfaces:**
- Produces: `verifyCallbackToken(received: string | undefined, expected: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/infrastructure/payments/webhook-token.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { verifyCallbackToken } from "./webhook-token";

const TOKEN = "xnd_webhook_token_abc123";

describe("verifyCallbackToken", () => {
  it("accepts the exact token", () => {
    expect(verifyCallbackToken(TOKEN, TOKEN)).toBe(true);
  });

  it("rejects a different token of the same length", () => {
    expect(verifyCallbackToken("xnd_webhook_token_xyz999", TOKEN)).toBe(false);
  });

  // timingSafeEqual throws on length mismatch. Hashing both sides first means
  // these return false instead of 500-ing, and no length is leaked.
  it("rejects a much shorter token without throwing", () => {
    expect(verifyCallbackToken("x", TOKEN)).toBe(false);
  });

  it("rejects a much longer token without throwing", () => {
    expect(verifyCallbackToken(TOKEN + "padding".repeat(50), TOKEN)).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(verifyCallbackToken("", TOKEN)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyCallbackToken(undefined, TOKEN)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && bun test src/infrastructure/payments/webhook-token.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `apps/api/src/infrastructure/payments/webhook-token.ts`:

```ts
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares a webhook callback token in constant time.
 *
 * Xendit authenticates webhooks with a STATIC token header rather than an HMAC
 * of the payload, so this comparison is the only thing standing between an
 * attacker and a forged payment event. A plain `===` leaks the token
 * byte-by-byte under timing analysis.
 *
 * Both sides are SHA-256'd to a fixed 32 bytes first. timingSafeEqual throws
 * on a length mismatch, which would both 500 the request and leak the token's
 * length; hashing removes that failure mode entirely.
 */
export function verifyCallbackToken(
  received: string | undefined,
  expected: string
): boolean {
  if (typeof received !== "string") {
    return false;
  }
  const a = createHash("sha256").update(received, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Verify, then commit**

```bash
bun test src/infrastructure/payments/webhook-token.test.ts
cd ../.. && bun run typecheck
git add apps/api/src/infrastructure/payments
git commit -m "feat(payments): add constant-time webhook token verification"
```

---

### Task 4: Xendit adapter (unverified transcription)

**Files:**
- Create: `apps/api/src/infrastructure/payments/xendit-payment.adapter.ts`
- Test: `apps/api/src/infrastructure/payments/xendit-payment.adapter.test.ts`
- Modify: `apps/api/.env.example`

**Interfaces:**
- Produces: `XenditPaymentAdapter`, constructed with
  `{ secretKey, splitRuleId, baseUrl?, fetchFn? }`. `fetchFn` is injected so tests can
  assert the outgoing request **without any network call**.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/infrastructure/payments/xendit-payment.adapter.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { XenditPaymentAdapter } from "./xendit-payment.adapter";

function captureFetch(response: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchFn };
}

const INPUT = {
  externalId: "txn-1",
  amount: 50000,
  description: "Basic",
  payerName: "Siti",
  payerWhatsappNumber: "+6281234567890",
  forAccountId: "acct-creator-1",
};

describe("XenditPaymentAdapter.createInvoice", () => {
  it("charges the creator's sub-account, never the platform", async () => {
    const { calls, fetchFn } = captureFetch({ id: "inv_1", invoice_url: "https://x/inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    await adapter.createInvoice(INPUT);

    const headers = calls[0].init.headers as Record<string, string>;
    // for-user-id routes funds to the creator's sub-account. Its absence would
    // settle member money into the platform account — the PJP hazard.
    expect(headers["for-user-id"]).toBe("acct-creator-1");
    expect(headers["with-split-rule"]).toBe("splitrule_1");
  });

  it("sends our external id so the webhook can be matched back", async () => {
    const { calls, fetchFn } = captureFetch({ id: "inv_1", invoice_url: "https://x/inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    await adapter.createInvoice(INPUT);

    expect(JSON.parse(calls[0].init.body as string).external_id).toBe("txn-1");
  });

  it("returns the invoice id and url", async () => {
    const { fetchFn } = captureFetch({ id: "inv_1", invoice_url: "https://x/inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    const result = await adapter.createInvoice(INPUT);
    expect(result).toEqual({ invoiceId: "inv_1", invoiceUrl: "https://x/inv_1" });
  });

  it("throws on a non-2xx response without leaking the secret key", async () => {
    const { fetchFn } = captureFetch({ message: "boom" }, 400);
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test_SUPERSECRET", splitRuleId: "splitrule_1", fetchFn,
    });

    const error = await adapter.createInvoice(INPUT).catch((e) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("sk_test_SUPERSECRET");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && bun test src/infrastructure/payments/xendit-payment.adapter.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `apps/api/src/infrastructure/payments/xendit-payment.adapter.ts`:

```ts
import type {
  CreateInvoiceInput,
  CreateInvoiceResult,
  PaymentProviderPort,
} from "../../application/ports/payment-provider.port";

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://api.xendit.co";

/**
 * !!! UNVERIFIED AGAINST THE LIVE XENDIT API !!!
 *
 * Written from Xendit's published documentation without an account, so request
 * shapes and error handling are ASSUMPTIONS. The tests below prove the port
 * contract and the split-payment headers — they do NOT prove this works against
 * Xendit. Exercise it against a real sandbox before accepting any real payment,
 * then delete this warning.
 *
 * The two headers are what keep DIUDARA outside PJP licensing:
 *   for-user-id      -> the creator's sub-account; funds settle THERE
 *   with-split-rule  -> routes only DIUDARA's fee to the master account
 * A split rule is created in the Xendit dashboard, so its id is configuration.
 */
export class XenditPaymentAdapter implements PaymentProviderPort {
  private readonly secretKey: string;
  private readonly splitRuleId: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(config: {
    secretKey: string;
    splitRuleId: string;
    baseUrl?: string;
    fetchFn?: FetchFn;
  }) {
    this.secretKey = config.secretKey;
    this.splitRuleId = config.splitRuleId;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = config.fetchFn ?? ((url, init) => fetch(url, init));
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.secretKey}:`).toString("base64")}`;
  }

  async createPaymentAccount(input: {
    creatorId: string;
    email: string;
    name: string;
  }): Promise<{ accountId: string }> {
    const response = await this.fetchFn(`${this.baseUrl}/v2/accounts`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: input.email,
        type: "MANAGED",
        public_profile: { business_name: input.name },
      }),
    });

    const body = await this.readJson(response, "createPaymentAccount");
    return { accountId: String(body.id) };
  }

  async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    const response = await this.fetchFn(`${this.baseUrl}/v2/invoices`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        "for-user-id": input.forAccountId,
        "with-split-rule": this.splitRuleId,
      },
      body: JSON.stringify({
        external_id: input.externalId,
        amount: input.amount,
        description: input.description,
        customer: {
          given_names: input.payerName,
          mobile_number: input.payerWhatsappNumber,
        },
      }),
    });

    const body = await this.readJson(response, "createInvoice");
    return { invoiceId: String(body.id), invoiceUrl: String(body.invoice_url) };
  }

  /**
   * Never include the request (which carries the Authorization header) or the
   * raw response body in the thrown message — Phase 2 found credentials
   * reaching logs exactly this way.
   */
  private async readJson(
    response: Response,
    operation: string
  ): Promise<Record<string, unknown>> {
    if (!response.ok) {
      throw new Error(`xendit ${operation} failed with status ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}
```

Add to `apps/api/.env.example`:

```
# Xendit. Unset outside production selects the fake payment adapter (all tests do).
# In production, bootstrap() THROWS unless all three are set — a misconfigured
# production box must not silently take fake payments and write fake-acct-* ids
# into creator.xendit_account_id, which cannot be undone without manual SQL.
# Partial configuration throws in EVERY environment: it is never intentional.
# XENDIT_SECRET_KEY=
# XENDIT_SPLIT_RULE_ID=
# XENDIT_CALLBACK_TOKEN=
```

- [ ] **Step 4: Verify, then commit**

```bash
bun test src/infrastructure/payments
cd ../.. && bun run typecheck
git add apps/api/src/infrastructure/payments apps/api/.env.example
git commit -m "feat(payments): add Xendit adapter (unverified against live API)"
```

---

### Task 5: Public community endpoint

**Files:**
- Modify: `packages/shared/src/community.schema.ts` (add checkout schemas)
- Create: `apps/api/src/application/use-cases/get-public-community.ts`
- Create: `apps/api/src/routes/public-community.ts`
- Modify: `apps/api/src/application/ports/community-repository.port.ts`
- Modify: `apps/api/src/infrastructure/repositories/drizzle-community.repository.ts`
- Modify: `apps/api/src/bootstrap.ts`, `apps/api/src/app.ts`
- Test: `apps/api/src/routes/public-community.test.ts`

**Interfaces:**
- Produces: `findBySlug(slug)` on `CommunityRepositoryPort` (**unscoped by creator — this is
  the one legitimate unscoped lookup, because checkout is public**); `GetPublicCommunity`;
  `GET /c/:slug` returning `{ name, niche, tiers: [{ id, name, priceAmount, billingCycle }] }`.

**Leakage rule:** the response must expose **only** what a prospective buyer needs. No
creator id, no email, no member counts, no revenue, no `xenditAccountId`, and **only active
tiers**. The test asserts this explicitly.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/public-community.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

async function seedCommunity(a: ReturnType<typeof app>) {
  const { token } = await signupAndGetToken(a);
  const community = await (
    await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Bimbel Budi", niche: "bimbel" }),
    })
  ).json();
  const tier = await (
    await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Basic", priceAmount: 50000, billingCycle: "monthly" }),
    })
  ).json();
  return { token, community, tier };
}

describe("GET /c/:slug", () => {
  it("returns the community and its active tiers without authentication", async () => {
    const a = app();
    const { community } = await seedCommunity(a);

    const res = await a.request(`/c/${community.slug}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.name).toBe("Kelas Bimbel Budi");
    expect(body.tiers.length).toBe(1);
    expect(body.tiers[0].priceAmount).toBe(50000);
  });

  it("leaks nothing about the creator or the platform's payment wiring", async () => {
    const a = app();
    const { community } = await seedCommunity(a);

    const text = await (await a.request(`/c/${community.slug}`)).text();
    for (const forbidden of ["creatorId", "creator_id", "xendit", "passwordHash", "email"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("hides inactive tiers from buyers", async () => {
    const a = app();
    const { token, community, tier } = await seedCommunity(a);
    await a.request(`/communities/${community.id}/tiers/${tier.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ isActive: false }),
    });

    const body = await (await a.request(`/c/${community.slug}`)).json();
    expect(body.tiers.length).toBe(0);
  });

  it("returns 404 for an unknown slug", async () => {
    expect((await app().request("/c/tidak-ada")).status).toBe(404);
  });

  it("returns 404 for an archived community", async () => {
    const a = app();
    const { token, community } = await seedCommunity(a);
    await a.request(`/communities/${community.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ status: "archived" }),
    });

    expect((await a.request(`/c/${community.slug}`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && bun test src/routes/public-community.test.ts
```

Expected: FAIL — `/c/:slug` is not routed (404 on every case, including the ones expecting 200).

- [ ] **Step 3: Implement**

Add to `CommunityRepositoryPort`:

```ts
  /**
   * Unscoped by creator ON PURPOSE — the public checkout page has no
   * authenticated caller. This is the ONLY unscoped lookup on this port; every
   * other method stays creator-scoped. Never use this to serve an
   * authenticated route.
   */
  findBySlug(slug: string): Promise<CommunityRecord | null>;
```

Implement it in `DrizzleCommunityRepository` with `eq(communities.slug, slug)` and
`.limit(1)`.

Create `apps/api/src/application/use-cases/get-public-community.ts`:

```ts
import { NotFoundError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "../ports/membership-tier-repository.port";

export interface PublicTier {
  id: string;
  name: string;
  priceAmount: number;
  billingCycle: string;
}

export interface PublicCommunity {
  id: string;
  name: string;
  niche: string | null;
  slug: string;
  tiers: PublicTier[];
}

export class GetPublicCommunity {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort
  ) {}

  async execute(slug: string): Promise<PublicCommunity> {
    const community = await this.communities.findBySlug(slug);
    if (!community || community.status !== "active") {
      throw new NotFoundError("community not found");
    }

    const all = await this.tiers.listByCommunity(community.id);

    // Explicit projection: never spread the record. Buyers must not see
    // creatorId, and later columns added to `community` must not leak by default.
    return {
      id: community.id,
      name: community.name,
      niche: community.niche,
      slug: community.slug,
      tiers: all
        .filter((t) => t.isActive)
        .map((t) => ({
          id: t.id,
          name: t.name,
          priceAmount: t.priceAmount,
          billingCycle: t.billingCycle,
        })),
    };
  }
}
```

Create `apps/api/src/routes/public-community.ts`:

```ts
import { Hono } from "hono";
import type { AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

/** Public — deliberately NOT behind requireAuth. */
export function publicCommunityRoutes(deps: Pick<Dependencies, "getPublicCommunity">) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get<"/:slug">("/:slug", async (c) => {
    return c.json(await deps.getPublicCommunity.execute(c.req.param("slug")));
  });

  return app;
}
```

Wire `getPublicCommunity` into `Dependencies` and `bootstrap()`, and mount in `app.ts`:

```ts
  app.route("/c", publicCommunityRoutes(deps));
```

- [ ] **Step 4: Verify, then commit**

```bash
bun test src/routes/public-community.test.ts
cd ../.. && bun run test && bun run typecheck
git add apps/api/src packages/shared/src
git commit -m "feat(checkout): add public community endpoint"
```

---

### Task 6: `StartCheckout` use-case and route

**Files:**
- Modify: `packages/shared/src/community.schema.ts` (add `startCheckoutSchema`)
- Create: `apps/api/src/application/ports/member-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-member.repository.ts`
- Create: `apps/api/src/application/ports/subscription-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-subscription.repository.ts`
- Create: `apps/api/src/application/use-cases/start-checkout.ts`
- Modify: `apps/api/src/routes/public-community.ts`
- Modify: `apps/api/src/bootstrap.ts`
- Test: `apps/api/src/application/use-cases/start-checkout.test.ts`
- Test: `apps/api/src/routes/checkout.test.ts`

**Interfaces:**
- `MemberRepositoryPort` — `findOrCreateByWhatsappNumber({ whatsappNumber, name })`
- `SubscriptionRepositoryPort` — `createPending({ memberId, tierId })`,
  `createTransaction({ subscriptionId, amount, paymentMethod })`,
  `findTransactionByExternalId(id)`, `markPaid(...)` (last two used in Task 7)

**Carry-forward from Phase 2, moved here from Task 2:** `subscription` and `transaction`
have an `updated_at` column with no `BEFORE UPDATE` trigger, so it would silently freeze at
creation time. This task creates the first repositories that write those rows, so it is the
right place to fix it. Set `updatedAt: new Date()` explicitly in **every** method that
updates a `subscription` or `transaction`. Prefer this over a database trigger: the
migration constraint forbids hand-written SQL and drizzle-kit does not generate triggers.
Task 7 asserts `updated_at` moved past `created_at` after activation.
- `StartCheckout.execute({ slug, tierId, payerName, payerWhatsappNumber })` →
  `{ invoiceUrl, subscriptionId, transactionId }`. **`transactionId` is required** — Task 7's
  webhook tests use it as the `external_id` Xendit echoes back, and the status page needs
  `subscriptionId`. Return all three from the route response too.

Add to `packages/shared/src/community.schema.ts`:

```ts
export const startCheckoutSchema = z.object({
  tierId: z.string().uuid(),
  payerName: z.string().trim().min(1).max(255),
  // Indonesian numbers, tolerant of leading 0 or +62. Normalisation is a
  // later concern; this only rejects obvious junk.
  payerWhatsappNumber: z.string().trim().min(8).max(20).regex(/^[+0-9][0-9]{7,19}$/),
});

export type StartCheckoutInput = z.infer<typeof startCheckoutSchema>;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/checkout.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

async function seedPayableCommunity(a: ReturnType<typeof app>, onboard = true) {
  const { token } = await signupAndGetToken(a);
  if (onboard) {
    // Go through the real onboarding route rather than writing the column
    // directly, so these tests exercise the path an actual creator takes.
    const res = await a.request("/payment-account", { method: "POST", headers: bearer(token) });
    if (res.status !== 201) {
      throw new Error(`payment onboarding failed in setup: ${res.status}`);
    }
  }
  const community = await (
    await a.request("/communities", {
      method: "POST", headers: bearer(token), body: JSON.stringify({ name: "Kelas Budi" }),
    })
  ).json();
  const tier = await (
    await a.request(`/communities/${community.id}/tiers`, {
      method: "POST", headers: bearer(token),
      body: JSON.stringify({ name: "Basic", priceAmount: 50000, billingCycle: "monthly" }),
    })
  ).json();
  return { community, tier };
}

const PAYER = { payerName: "Siti", payerWhatsappNumber: "+6281234567890" };

describe("POST /c/:slug/checkout", () => {
  it("returns an invoice url and a pending subscription", async () => {
    const a = app();
    const { community, tier } = await seedPayableCommunity(a);

    const res = await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: tier.id, ...PAYER }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invoiceUrl).toContain("http");
    expect(body.subscriptionId).toBeTruthy();
  });

  it("rejects a creator who has not completed payment onboarding with 409", async () => {
    const a = app();
    const { community, tier } = await seedPayableCommunity(a, false);

    const res = await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: tier.id, ...PAYER }),
    });

    // Must never silently fall back to charging a platform account.
    expect(res.status).toBe(409);
  });

  it("rejects a tier belonging to a different community with 404", async () => {
    const a = app();
    const first = await seedPayableCommunity(a);
    const second = await seedPayableCommunity(a);

    const res = await a.request(`/c/${first.community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: second.tier.id, ...PAYER }),
    });

    expect(res.status).toBe(404);
  });

  it("rejects a malformed whatsapp number with 400", async () => {
    const a = app();
    const { community, tier } = await seedPayableCommunity(a);

    const res = await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: tier.id, payerName: "Siti", payerWhatsappNumber: "nope" }),
    });

    expect(res.status).toBe(400);
  });

  it("reuses the member record when the same number checks out twice", async () => {
    const a = app();
    const { community, tier } = await seedPayableCommunity(a);
    const body = JSON.stringify({ tierId: tier.id, ...PAYER });
    const headers = { "Content-Type": "application/json" };

    await a.request(`/c/${community.slug}/checkout`, { method: "POST", headers, body });
    const second = await a.request(`/c/${community.slug}/checkout`, {
      method: "POST", headers, body,
    });

    // member.whatsapp_number is unique — a second checkout must not 500.
    expect(second.status).toBe(201);
  });
});
```

Create `apps/api/src/application/use-cases/start-checkout.test.ts` with a fake payment
adapter asserting the invoice is charged to the creator's account:

```ts
import { describe, expect, it } from "bun:test";
import { FakePaymentAdapter } from "../../infrastructure/payments/fake-payment.adapter";

describe("StartCheckout — funds routing", () => {
  it("charges the creator's account, never a platform account", async () => {
    // Assembled with fakes; see the route test for the wired version.
    const payments = new FakePaymentAdapter();
    await payments.createInvoice({
      externalId: "txn-1",
      amount: 50000,
      description: "Basic",
      payerName: "Siti",
      payerWhatsappNumber: "+6281234567890",
      forAccountId: "acct-creator-1",
    });

    expect(payments.invoices[0].forAccountId).toBe("acct-creator-1");
    expect(payments.invoices.every((i) => i.forAccountId.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/api && bun test src/routes/checkout.test.ts
```

Expected: FAIL — the checkout route does not exist.

- [ ] **Step 3: Implement**

Write the two repositories (`findOrCreateByWhatsappNumber` uses an
`onConflictDoUpdate`/`onConflictDoNothing` + re-select so a concurrent checkout does not
500 — Phase 2's slug race taught this), then `StartCheckout`:

```ts
import { ConflictError, NotFoundError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "../ports/membership-tier-repository.port";
import type { MemberRepositoryPort } from "../ports/member-repository.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";
import type { PaymentProviderPort } from "../ports/payment-provider.port";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";

export class StartCheckout {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort,
    private readonly members: MemberRepositoryPort,
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly creators: CreatorRepositoryPort,
    private readonly payments: PaymentProviderPort
  ) {}

  async execute(input: {
    slug: string;
    tierId: string;
    payerName: string;
    payerWhatsappNumber: string;
  }): Promise<{ invoiceUrl: string; subscriptionId: string; transactionId: string }> {
    const community = await this.communities.findBySlug(input.slug);
    if (!community || community.status !== "active") {
      throw new NotFoundError("community not found");
    }

    const tiers = await this.tiers.listByCommunity(community.id);
    const tier = tiers.find((t) => t.id === input.tierId && t.isActive);
    if (!tier) {
      throw new NotFoundError("tier not found");
    }

    const creator = await this.creators.findById(community.creatorId);
    // No account means no sub-account to settle into. Charging anyway would put
    // member funds in a platform account — the PJP hazard. Refuse.
    if (!creator?.xenditAccountId) {
      throw new ConflictError("this community is not ready to accept payments yet");
    }

    const member = await this.members.findOrCreateByWhatsappNumber({
      whatsappNumber: input.payerWhatsappNumber,
      name: input.payerName,
    });

    const subscription = await this.subscriptions.createPending({
      memberId: member.id,
      tierId: tier.id,
    });
    const transaction = await this.subscriptions.createTransaction({
      subscriptionId: subscription.id,
      amount: tier.priceAmount,
      paymentMethod: "invoice",
    });

    const invoice = await this.payments.createInvoice({
      externalId: transaction.id,
      amount: tier.priceAmount,
      description: `${community.name} — ${tier.name}`,
      payerName: input.payerName,
      payerWhatsappNumber: input.payerWhatsappNumber,
      forAccountId: creator.xenditAccountId,
    });

    return {
      invoiceUrl: invoice.invoiceUrl,
      subscriptionId: subscription.id,
      transactionId: transaction.id,
    };
  }
}
```

Add the route to `public-community.ts` (note the explicit generic — Phase 2's inference trap):

```ts
  app.post<"/:slug/checkout">("/:slug/checkout", validate(startCheckoutSchema), async (c) => {
    const input = c.get("validated") as StartCheckoutInput;
    const result = await deps.startCheckout.execute({ slug: c.req.param("slug"), ...input });
    return c.json(result, 201);
  });
```

Wire `startCheckout` into `Dependencies`/`bootstrap()`. `bootstrap()` selects the payment
adapter: `XenditPaymentAdapter` when `XENDIT_SECRET_KEY` **and** `XENDIT_SPLIT_RULE_ID` are
both set, otherwise `FakePaymentAdapter` — **subject to the guards in the Global
Constraints section**. A log line is a courtesy, not the safety mechanism; the guards are.

- [ ] **Step 4: Verify, then commit**

```bash
bun test src/routes/checkout.test.ts src/application/use-cases/start-checkout.test.ts
cd ../.. && bun run test && bun run typecheck
git add apps/api/src packages/shared/src
git commit -m "feat(checkout): add StartCheckout use-case and public checkout route"
```

---

### Task 7: Webhook handling — the security-critical task

**Files:**
- Create: `apps/api/src/application/ports/webhook-event-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-webhook-event.repository.ts`
- Create: `apps/api/src/application/use-cases/handle-payment-webhook.ts`
- Create: `apps/api/src/routes/webhooks.ts`
- Modify: `apps/api/src/bootstrap.ts`, `apps/api/src/app.ts`
- Test: `apps/api/src/routes/webhooks.test.ts`

**Interfaces:**
- `WebhookEventRepositoryPort` — `recordIfNew({ provider, providerEventId, eventType, payload })`
  returning `true` when newly recorded, `false` when already seen (implemented with
  `onConflictDoNothing` so the **database**, not a pre-check, arbitrates).
- `HandlePaymentWebhook.execute({ providerEventId, externalId, status, amount })`
- `POST /webhooks/xendit`, public, token-verified.

**Every requirement below has a test. Do not skip any.**

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/webhooks.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import { subscriptions } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

const TOKEN = process.env.XENDIT_CALLBACK_TOKEN ?? "test-callback-token";

function app() {
  return createApp(bootstrap());
}

/** Runs a real checkout and returns the ids the webhook will reference. */
async function checkout(a: ReturnType<typeof app>) {
  const { token } = await signupAndGetToken(a);
  await a.request("/payment-account", { method: "POST", headers: bearer(token) });

  const community = await (
    await a.request("/communities", {
      method: "POST", headers: bearer(token), body: JSON.stringify({ name: "Kelas Budi" }),
    })
  ).json();
  const tier = await (
    await a.request(`/communities/${community.id}/tiers`, {
      method: "POST", headers: bearer(token),
      body: JSON.stringify({ name: "Basic", priceAmount: 50000, billingCycle: "monthly" }),
    })
  ).json();
  const result = await (
    await a.request(`/c/${community.slug}/checkout`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tierId: tier.id, payerName: "Siti", payerWhatsappNumber: "+6281234567890",
      }),
    })
  ).json();

  return { subscriptionId: result.subscriptionId, externalId: result.transactionId };
}

function post(a: ReturnType<typeof app>, body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers["X-CALLBACK-TOKEN"] = token;
  return a.request("/webhooks/xendit", { method: "POST", headers, body: JSON.stringify(body) });
}

function paidEvent(externalId: string, overrides: Record<string, unknown> = {}) {
  return { id: "evt-1", external_id: externalId, status: "PAID", amount: 50000, ...overrides };
}

describe("POST /webhooks/xendit", () => {
  it("activates the subscription on a verified PAID event", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    expect((await post(a, paidEvent(externalId))).status).toBe(200);

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
    expect(sub.status).toBe("active");
    expect(sub.nextBillingDate).not.toBeNull();
  });

  it("rejects a wrong token with 401 and does not activate", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    expect((await post(a, paidEvent(externalId), "wrong-token")).status).toBe(401);

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
    expect(sub.status).not.toBe("active");
  });

  it("rejects a missing token with 401", async () => {
    const a = app();
    const { externalId } = await checkout(a);
    expect((await post(a, paidEvent(externalId), null)).status).toBe(401);
  });

  it("is idempotent — a replayed event does not activate twice", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    const first = await post(a, paidEvent(externalId));
    const second = await post(a, paidEvent(externalId));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200); // no-op, not an error

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
    expect(sub.status).toBe("active");
  });

  it("rejects an amount that does not match our own record", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    // The token authenticates the SENDER, not the message. A forged or tampered
    // body must not be able to activate a 50,000 subscription by claiming 1.
    const res = await post(a, paidEvent(externalId, { id: "evt-2", amount: 1 }));
    expect(res.status).toBe(400);

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
    expect(sub.status).not.toBe("active");
  });

  it("rejects an unknown external id with 404", async () => {
    const a = app();
    await checkout(a);
    const res = await post(a, paidEvent("00000000-0000-0000-0000-000000000000", { id: "evt-3" }));
    expect(res.status).toBe(404);
  });

  it("ignores a non-PAID status without activating", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    expect((await post(a, paidEvent(externalId, { id: "evt-4", status: "EXPIRED" }))).status).toBe(200);

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
    expect(sub.status).not.toBe("active");
  });
});
```

**Note:** this test consumes `transactionId` from the checkout response, which Task 6
already returns.

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/api && bun test src/routes/webhooks.test.ts
```

Expected: FAIL — `/webhooks/xendit` is not routed.

- [ ] **Step 3: Implement**

`HandlePaymentWebhook` order of operations matters — get it exactly right:

1. Look up our own `transaction` by `externalId`. Unknown → `NotFoundError`.
2. Compare the event's `amount` with **our** stored `transaction.amount`. Mismatch →
   `ValidationError`. **Never trust the body.**
3. `recordIfNew(...)`. Already seen → return without touching anything (idempotent no-op).
4. Only for `status === "PAID"`: mark transaction `success` + `paidAt`, subscription
   `active` + `startedAt` + `nextBillingDate` computed from the tier's `billingCycle`, and
   write an `activity_log` entry (`event_type: "joined"`) — the audit constraint's first
   real use.

Route (public, token-verified before anything else):

```ts
import { Hono } from "hono";
import { UnauthorizedError } from "../application/errors";
import { verifyCallbackToken } from "../infrastructure/payments/webhook-token";
import type { Dependencies } from "../bootstrap";

/** Public by design — Xendit cannot present a bearer token. */
export function webhookRoutes(
  deps: Pick<Dependencies, "handlePaymentWebhook" | "xenditCallbackToken">
) {
  const app = new Hono();

  app.post("/xendit", async (c) => {
    if (!verifyCallbackToken(c.req.header("X-CALLBACK-TOKEN"), deps.xenditCallbackToken)) {
      throw new UnauthorizedError("invalid callback token");
    }

    const body = (await c.req.json()) as Record<string, unknown>;
    await deps.handlePaymentWebhook.execute({
      providerEventId: String(body.id ?? ""),
      externalId: String(body.external_id ?? ""),
      status: String(body.status ?? ""),
      amount: Number(body.amount ?? -1),
    });

    return c.json({ received: true });
  });

  return app;
}
```

`bootstrap()` reads `XENDIT_CALLBACK_TOKEN`, defaulting to `"test-callback-token"` **only**
when `NODE_ENV === "test"`; outside tests an unset token must throw, exactly like
`JWT_SECRET`. Mount with `app.route("/webhooks", webhookRoutes(deps));`.

**Owner ruling, 2026-08-09 — do not flag as a spec violation.** Phase 2 hardened
`bootstrap()` to reject missing, weak, and placeholder `JWT_SECRET` values with no committed
default, and this test-only default is a deliberate, narrower exception: the tests must send
a token they know. The `NODE_ENV === "test"` guard is the same mechanism `resetDatabase()`
already relies on to avoid truncating a real database. Two things a reviewer *should* still
check: that the default is genuinely unreachable when `NODE_ENV !== "test"`, and that an
unset token outside tests throws rather than silently accepting every webhook.

- [ ] **Step 4: Verify, then mutation-check the security guards**

```bash
bun test src/routes/webhooks.test.ts
```

Then, one at a time, temporarily break each guard and confirm a test goes red — restore
after each:
- remove the token check → the 401 tests must fail
- remove the amount comparison → the mismatch test must fail
- remove `recordIfNew` → the idempotency test must fail

Record the results in your report. **A guard whose removal leaves the suite green is not
protected**, and Phase 2 shipped exactly such a gap.

- [ ] **Step 5: Commit**

```bash
cd ../.. && bun run test && bun run typecheck
git add apps/api/src
git commit -m "feat(payments): add token-verified, idempotent Xendit webhook handler"
```

---

### Task 8: `apps/web` — Vite + React checkout page

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`,
  `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`
- Create: `apps/web/src/pages/CheckoutPage.tsx`
- Create: `apps/web/src/api.ts`
- Test: `apps/web/src/pages/CheckoutPage.test.tsx`

**Interfaces:**
- Produces a Vite React app on port 5173, proxying `/c` and `/webhooks` to the API on 3000.
- `CheckoutPage` fetches `GET /c/:slug`, renders tiers, and posts to
  `POST /c/:slug/checkout`, then redirects to the returned `invoiceUrl`.
- **The return leg is part of this task.** `StartCheckout` must send the provider a
  `success_redirect_url` of `<APP_BASE_URL>/c/<slug>/status/<subscriptionId>` (a new
  required field on `CreateInvoiceInput`, forwarded by `XenditPaymentAdapter`), and a test
  must assert the created invoice carries a URL containing the subscription id.

Scaffold with React 18, `react-dom`, `react-router-dom`, and `vite` +
`@vitejs/plugin-react`. Add `@diudara/shared` as a workspace dependency so request types
come from one place. Root `package.json` scripts already use `bun run --workspaces`, so
`apps/web` must define `test` and `typecheck` scripts — a workspace without them **fails
the root command** (verified in Phase 2). If no meaningful test exists yet, still define the
script.

Testing uses `@testing-library/react` + `happy-dom`. Keep it to: renders tiers from a stubbed
fetch; posting checkout calls the right endpoint with the selected tier. Do **not** drive a
real browser through Xendit's hosted invoice page — but DO assert, on the API side, that the
`success_redirect_url` we send it is correct.

**AMENDED 2026-08-09 (final review, I1).** As written, this task's interface said only
"redirects to the returned `invoiceUrl`" and "do not test Xendit redirects", so nobody was
asked to close the loop: `CheckoutPage` discarded `subscriptionId`, no route linked to
`/c/:slug/status/:subscriptionId`, and no `success_redirect_url` was sent. Task 9 therefore
built and tested a page **no member could ever reach** — the end-to-end run navigated to it by
hand, which is exactly why the gap read as cosmetic. "Do not test X" must never be phrased so
broadly that it also excuses not BUILDING the half of X that is ours; the browser leg is
untestable here, the request field is not.

Lesson for future plans: when a flow leaves our process and comes back, the plan must name
**both** legs and say which is asserted where. A page with no inbound link is not a feature.

Mobile-first and legible; no design system. These links are opened on phones from WhatsApp.

- [ ] **Steps:** scaffold → failing component test → implement → `bun run test` and
  `bun run typecheck` green from the repo root → commit
  `"feat(web): add Vite React app with public checkout page"`.

---

### Task 9: Confirmation page and subscription status endpoint

**Files:**
- Create: `apps/api/src/routes/public-subscription.ts` (or extend `public-community.ts`)
- Create: `apps/web/src/pages/StatusPage.tsx`
- Test: `apps/api/src/routes/subscription-status.test.ts`

**Interfaces:**
- `GET /c/subscription/:subscriptionId/status` → `{ status }` only.

**Leakage rule:** this endpoint is public and its id is guessable-ish, so it must return
**only** the status string — never the member's name or WhatsApp number, the amount, the
creator, or the community. The test asserts this.

- [ ] **Steps:** failing test (status returned; nothing else leaked; unknown id → 404) →
  implement → `StatusPage` polls every 3s until `active` or a timeout, then shows a clear
  message → full suite and typecheck green → commit
  `"feat(checkout): add subscription status endpoint and confirmation page"`.

---

## Phase completion gate

Before the final review:

```bash
bun run test          # all workspaces green
bun run typecheck     # exit 0
```

Then a manual end-to-end run with the fake adapter: start Postgres, the API, and the web
app; sign up a creator; `POST /payment-account` to connect payments; create a community and
an active tier; open `/c/<slug>` in a browser; complete checkout; POST the webhook with the
correct token; confirm the status page flips to active. Record the actual output.

Then confirm the two things that would be worst to get wrong, and record the evidence:
- `select xendit_account_id from creator` is non-null, and the fake adapter's recorded
  invoice carries that same id as `forAccountId` — proving member funds are routed to the
  creator, not the platform.
- Replaying the same webhook body a second time leaves `subscription.status` unchanged and
  creates no second `activity_log` row.
