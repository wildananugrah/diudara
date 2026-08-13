# Free Communities and Join Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator can run a **free** community where members ask to join and the owner approves, instead of paying — and the API boots and serves without Xendit configured at all.

**Architecture:** A new `community.access_mode` (`paid` | `request`) and a new `join_request` table. Approval creates an `active` subscription with a **null** `next_billing_date` and enqueues the *same* `grant_access` outbox row a payment enqueues, so Telegram-invite delivery is completely untouched. `selectPaymentProvider` stops throwing when Xendit is absent outside `development`/`test` and instead returns a disabled payment path.

**Tech Stack:** Postgres + Drizzle, Bun + Hono (ports and adapters), Vite + React, `bun:test`.

## Global Constraints

From `docs/superpowers/specs/2026-08-13-free-communities-design.md`.

- **No `PAYMENT_GATEWAY_PROVIDER` variable.** It was considered and rejected. The Xendit keys already state whether Xendit is available; `community.access_mode` states what each community does.
- **Absent Xendit keys must never mean "use the fake adapter" outside `RELAXED_NODE_ENVS`** (`development` and `test` only). Disabled means *no payment path*, not a stub. An implementer who falls back to `FakePaymentAdapter` here reintroduces the exact hazard the original throw prevented: unrecoverable `fake-acct-*` ids written into `creator.xendit_account_id`.
- **The half-configured throw stays, in every environment.** `XENDIT_SECRET_KEY` and `XENDIT_SPLIT_RULE_ID` set together or not at all. Existing tests for it must pass unchanged.
- **A `paid` community never accepts a free join.** With payments disabled it renders with *no join path at all* — not checkout, and **not** the request form. Falling back to the request form would give away priced memberships because an env var was missing.
- **Approval enqueues `grant_access`, the same row a payment enqueues.** `GrantChannelAccess` is not modified by this plan.
- **A free subscription has `next_billing_date = null`** and is therefore invisible to `findDueForRenewal` (which carries an explicit `isNotNull`) and, in consequence, to the churn pass. Task 1 proves this rather than asserting it.
- **Rejection is silent.** No message is sent. The member may request again; there is no blocklist.
- **Members have no accounts.** Identity is the WhatsApp number, via `findOrCreateByWhatsappNumber`.
- **Owner-scoped endpoints answer 404, never 403**, so a stranger cannot confirm a resource exists.
- **All member- and creator-facing copy in Bahasa Indonesia**, matching the surrounding pages' tone.
- A failing `expect(<DOM element>).toBeNull()` **hangs `bun test`** (~178 s, 335 MB); there is a source-scan guard at `apps/web/src/test/no-hanging-dom-assertions.test.ts`. Count elements or assert booleans.
- Dashboard component tests render under `<StrictMode>` via `renderPage` in `apps/web/src/dashboard/testing.tsx`. That is load-bearing — do not remove it to make a test pass.
- Migrations are **Drizzle-generated only**: edit `apps/api/src/db/schema.ts`, then `bun run db:generate`. Never hand-write a file in `apps/api/drizzle/`.
- Root gates: `bun run test` and `bun run typecheck` from the repo root — **`bun run test`, never bare `bun test`**, which produces ~123 spurious failures from the root because `apps/web` needs its own bunfig preload. Baseline: 1836 pass / 0 fail.

---

### Task 1: The schema, the repository, and proof the billing passes ignore free members

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/00XX_*.sql` (generated, never hand-written)
- Create: `apps/api/src/application/ports/join-request-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-join-request.repository.ts` + `.test.ts`
- Modify: `apps/api/src/application/ports/subscription-repository.port.ts`
- Modify: `apps/api/src/infrastructure/repositories/drizzle-subscription.repository.ts` + `.test.ts`

**Interfaces:**
- Produces: `JoinRequestRepositoryPort`, `JoinRequestRecord`, and `SubscriptionRepositoryPort.createActiveWithoutBilling`. Tasks 3, 4 and 5 consume these.

**Schema additions.** On `communities`, beside `status`:

```ts
accessMode: varchar("access_mode", { length: 16 }).notNull().default("paid"),
```

`default("paid")` means existing rows keep today's behaviour with no backfill.

A new table, following the file's existing style:

```ts
export const joinRequests = pgTable(
  "join_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id),
    tierId: uuid("tier_id")
      .notNull()
      .references(() => membershipTiers.id),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => creators.id),
  },
  (table) => [
    // ONE open request per member per community, arbitrated by the DATABASE rather
    // than by a read-then-write — the same reason `subscription_member_tier_active_unique`
    // is a partial unique index. Two submits in the same instant cannot both win.
    // Decided rows are deliberately outside the index: they are the audit trail, and
    // rejection being silent makes them the only account of what happened.
    uniqueIndex("join_request_community_member_pending_unique")
      .on(table.communityId, table.memberId)
      .where(sql`${table.status} = 'pending'`),
    index("join_request_community_status_idx").on(table.communityId, table.status),
  ],
);
```

**The port:**

```ts
export interface JoinRequestRecord {
  id: string;
  communityId: string;
  tierId: string;
  memberId: string;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
}

export interface PendingJoinRequestRow {
  id: string;
  memberId: string;
  memberName: string;
  memberWhatsappNumber: string;
  tierId: string;
  tierName: string;
  createdAt: Date;
}

export interface JoinRequestRepositoryPort {
  /** Returns null when a pending request already exists — the unique index refused it. */
  createPending(input: {
    communityId: string;
    tierId: string;
    memberId: string;
  }): Promise<JoinRequestRecord | null>;
  findById(id: string): Promise<JoinRequestRecord | null>;
  listPendingForCommunity(communityId: string): Promise<PendingJoinRequestRow[]>;
  /** Returns false when the row was already decided — the caller turns that into 409. */
  decide(input: {
    id: string;
    status: "approved" | "rejected";
    decidedBy: string;
    decidedAt: Date;
  }): Promise<boolean>;
}
```

`createPending` must catch the unique-violation (Postgres `23505`) and return `null` rather than throwing — the caller turns that into a 409. `decide` must be a conditional update (`where id = $1 and status = 'pending'`) and return whether a row changed, so two owners clicking at once cannot both win.

**The subscription addition:**

```ts
/**
 * An approved FREE membership. `next_billing_date` is deliberately null: it is what
 * makes this row invisible to `findDueForRenewal` (which carries an explicit
 * isNotNull) and therefore to the churn pass that follows it. A free membership
 * lasts until the owner revokes it.
 */
createActiveWithoutBilling(input: {
  memberId: string;
  tierId: string;
}): Promise<SubscriptionRecord>;
```

- [ ] **Step 1: Write the failing repository tests.** Cover: `createPending` returns a row; a **second** `createPending` for the same `(communityId, memberId)` returns `null` while the first still exists; a pending request for the *same member in a different community* succeeds; `decide` returns `true` once and `false` on a second call for the same id; `listPendingForCommunity` returns only `pending` rows and joins the member's name and WhatsApp number and the tier name.

- [ ] **Step 2: Write the failing billing-isolation test**, in `drizzle-subscription.repository.test.ts`. This is the one that matters most in this task:

```ts
test("a free subscription is invisible to the renewal and churn passes", async () => {
  const free = await repo.createActiveWithoutBilling({ memberId, tierId });
  expect(free.status).toBe("active");
  expect(free.nextBillingDate).toBeNull();

  // `findDueForRenewal` and `findPastGraceDeadline` both return `DueRenewalRecord[]`,
  // which NESTS the row as `subscription: SubscriptionRecord` — there is no flat
  // `subscriptionId` on it.
  const due = await repo.findDueForRenewal({
    dueOnOrBefore: "2099-01-01",
    limit: 100,
  });
  expect(due.some((r) => r.subscription.id === free.id)).toBe(false);

  const past = await repo.findPastGraceDeadline({
    now: new Date("2099-01-01T00:00:00Z"),
    limit: 100,
  });
  expect(past.some((r) => r.subscription.id === free.id)).toBe(false);
});
```

A far-future date is used deliberately: it proves the row is excluded because its due date is **null**, not because the date has not arrived.

- [ ] **Step 3: Run the tests and confirm they fail** — `cd apps/api && bun test src/infrastructure/repositories/drizzle-join-request.repository.test.ts src/infrastructure/repositories/drizzle-subscription.repository.test.ts`. Expected: failures naming the missing table and the missing `createActiveWithoutBilling`.

- [ ] **Step 4: Edit `schema.ts`, then generate the migration** — `cd apps/api && bun run db:generate`, then `bun run db:migrate`. Inspect the generated SQL and confirm it contains the partial unique index with its `WHERE status = 'pending'` clause; if it does not, fix the schema and regenerate rather than editing the SQL.

- [ ] **Step 5: Implement the port and repository, and `createActiveWithoutBilling`.**

- [ ] **Step 6: Run the root gates** — `bun run test` and `bun run typecheck` from the repo root.

- [ ] **Step 7: Commit** `"feat(db): add community.access_mode and the join_request table"`.

---

### Task 2: Payments become optional, and disabled never means fake

**Files:**
- Modify: `apps/api/src/bootstrap.ts` (`selectPaymentProvider` around line 465, and the route wiring)
- Modify: `apps/api/src/bootstrap.test.ts`
- Modify: `apps/api/src/routes/public-community.ts`
- Modify: `apps/api/src/application/use-cases/create-community.ts`, `update-community.ts` + their tests
- Modify: `apps/api/.env.example`, `CONTRIBUTING.md`

**Interfaces:**
- Produces: `selectPaymentProvider` returning `PaymentProviderPort | null`, where `null` means *payments are disabled*. Task 3 relies on `null` closing the checkout route.

**The behaviour table, which is the whole task.** Only the last row changes:

| Xendit keys | `NODE_ENV` | Result |
|---|---|---|
| Both set | any | `XenditPaymentAdapter` — unchanged |
| Exactly one set | any | **Throws** — unchanged, in every environment |
| Neither set | `development` / `test` | `FakePaymentAdapter` — unchanged |
| Neither set | anything else | **Returns `null`.** Today this throws |

**Do not delete the existing throw's reasoning when you delete the throw.** Move it into a comment on the `null` branch: the fake adapter writes unrecoverable `fake-acct-*` ids into `creator.xendit_account_id`, and returning `null` — rather than a fake — is the only reason removing the throw is safe.

**Wiring:** when `selectPaymentProvider` returns `null`, `StartCheckout` is **not constructed** and `POST /c/:slug/checkout` is **not registered**, so it 404s through the normal not-found path rather than returning a stub or a 500.

**The creator guard:** `CreateCommunity` and `UpdateCommunity` refuse `accessMode: "paid"` when payments are disabled, with `ConflictError`:

```
"pembayaran belum dikonfigurasi di server ini, jadi komunitas berbayar belum bisa dibuat"
```

- [ ] **Step 1: Write the failing tests** in `bootstrap.test.ts`, one per row of the table above, each with `bun --no-env-file` semantics in mind — Bun otherwise re-loads `apps/api/.env` behind you. Add explicitly: **with neither key set and `NODE_ENV=production`, the returned provider is `null` and is not an instance of `FakePaymentAdapter`.** Assert the negative, not just the null — that is the constraint that matters.

- [ ] **Step 2: Write the failing route test** — with payments disabled, `POST /c/:slug/checkout` returns **404**; with payments enabled it behaves exactly as today.

- [ ] **Step 3: Write the failing use-case tests** — `CreateCommunity` and `UpdateCommunity` refuse `accessMode: "paid"` while payments are disabled, and allow it when enabled. `accessMode: "request"` is always allowed.

- [ ] **Step 4: Run them and confirm they fail.**

- [ ] **Step 5: Implement**, keeping the half-configured throw and its tests untouched.

- [ ] **Step 6: Document it** — `apps/api/.env.example` states that leaving both Xendit keys unset disables payments outside `development`/`test` rather than blocking boot, and that communities must then use `access_mode = request`. Add the same to `CONTRIBUTING.md` where the other provider groups are described.

- [ ] **Step 7: Root gates, then commit** `"feat(payments): boot without Xendit instead of refusing to start"`.

---

### Task 3: Requesting to join

**Files:**
- Create: `apps/api/src/application/use-cases/request-to-join.ts` + `.test.ts`
- Create: `apps/api/src/application/ports/join-request-unit-of-work.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-join-request-unit-of-work.ts`
- Modify: `apps/api/src/application/use-cases/get-public-community.ts` + test
- Modify: `apps/api/src/routes/public-community.ts` + test
- Modify: `apps/api/src/application/ports/outbox-repository.port.ts`
- Modify: `packages/shared/src/community.schema.ts`
- Modify: `apps/api/src/bootstrap.ts`

**Interfaces:**
- Consumes: `JoinRequestRepositoryPort` (Task 1).
- Produces: `OUTBOX_NOTIFY_JOIN_REQUEST = "notify_join_request"` (Task 5 consumes it); `PublicCommunity.accessMode`; `POST /c/:slug/join-request`; `GET /c/:slug/request/:joinRequestId`.

**`PublicCommunity` gains one field**, projected explicitly — never spread the record, per the existing comment in that file:

```ts
accessMode: community.accessMode,
```

**The request schema**, in `packages/shared/src/community.schema.ts`, mirroring `startCheckoutSchema` exactly so the two forms validate identically:

```ts
export const joinRequestSchema = z.object({
  tierId: z.string().uuid(),
  payerName: z.string().trim().min(1).max(255),
  payerWhatsappNumber: z.string().trim().min(8).max(20).regex(/^[+0-9][0-9]{7,19}$/),
});
export type JoinRequestInput = z.infer<typeof joinRequestSchema>;
```

**`RequestToJoin.execute`** returns `{ joinRequestId: string }` and, in order:

1. `communities.findBySlug`; 404 unless found and in `VISIBLE_STATUSES`
2. 409 `"komunitas ini sedang tidak menerima anggota baru"` unless `status === "active"`
3. **404** unless `accessMode === "request"` — a `paid` community never accepts a free join, whatever the deployment's payment configuration
4. tier must be active and belong to this community, else 404
5. `members.findOrCreateByWhatsappNumber`
6. 409 if `subscriptions.hasLiveSubscriptionInCommunity(member.id, community.id)`, message: `"Anda sudah menjadi anggota komunitas ini. Cek WhatsApp Anda untuk tautan undangan grup."`
7. **In one unit-of-work transaction:** `joinRequests.createPending(...)`, and if it returns `null`, throw `ConflictError("permintaan Anda sudah menunggu persetujuan pemilik komunitas")`; otherwise `outbox.enqueue({ eventType: OUTBOX_NOTIFY_JOIN_REQUEST, payload: { joinRequestId } })`

Step 7 is one transaction so a request can never exist without its notification. The unit of work mirrors `PaymentActivationUnitOfWorkPort`:

```ts
export interface JoinRequestRepositories {
  joinRequests: JoinRequestRepositoryPort;
  outbox: OutboxRepositoryPort;
  activityLog: ActivityLogRepositoryPort;
}
export interface JoinRequestUnitOfWorkPort {
  run<T>(work: (repositories: JoinRequestRepositories) => Promise<T>): Promise<T>;
}
```

**`GET /c/:slug/request/:joinRequestId`** returns `{ status, communitySlug, subscriptionId }` where `subscriptionId` is non-null only once approved. It must **not** return the member's name or WhatsApp number: the URL is guessable in the same way the subscription status URL is, and it must not become a lookup for who joined what.

- [ ] **Step 1: Write the failing use-case tests** — one per refusal above, plus the happy path asserting that **exactly one** `notify_join_request` row is enqueued, and a test that when `createPending` returns `null` **no outbox row is enqueued at all**.

- [ ] **Step 2: Write the failing route tests** — `POST /c/:slug/join-request` returns 201 with a `joinRequestId`; returns 404 for a `paid` community; `GET /c/:slug` includes `accessMode`; `GET /c/:slug/request/:id` returns the status and **does not** include a name or WhatsApp number.

- [ ] **Step 3: Run them and confirm they fail.**

- [ ] **Step 4: Implement**, wiring the use case and both routes in `bootstrap.ts`.

- [ ] **Step 5: Root gates, then commit** `"feat(members): let a member request to join a free community"`.

---

### Task 4: Approving and rejecting

**Files:**
- Create: `apps/api/src/application/use-cases/decide-join-request.ts` + `.test.ts`
- Create: `apps/api/src/routes/join-requests.ts` + `.test.ts`
- Modify: `apps/api/src/bootstrap.ts`

**Interfaces:**
- Consumes: `JoinRequestRepositoryPort`, `JoinRequestUnitOfWorkPort`, `SubscriptionRepositoryPort.createActiveWithoutBilling`.
- Produces: `GET /communities/:communityId/join-requests`, `POST /communities/:communityId/join-requests/:requestId/approve`, `POST .../reject`.

**One use case with two outcomes**, not two use cases — the ownership check, the already-decided check and the `activity_log` write are identical, and duplicating them is how they drift apart:

```ts
execute(input: {
  creatorId: string;
  communityId: string;
  requestId: string;
  decision: "approved" | "rejected";
}): Promise<{ subscriptionId: string | null }>
```

Order:

1. `communities.findByIdForCreator(communityId, creatorId)` — **404** if null. Note the argument order: the id comes first. A stranger must not learn the community exists.
2. `joinRequests.findById(requestId)` — 404 if null **or** if its `communityId` differs. Never trust the id alone; the path's community is the authority.
3. tier must still be active — else `ConflictError("tier ini sudah tidak aktif. Aktifkan kembali tier tersebut atau tolak permintaan ini.")`
4. **In one transaction:** `decide(...)`; if it returns `false`, throw `ConflictError("permintaan ini sudah diproses")`. On `approved`, `createActiveWithoutBilling` then `outbox.enqueue({ eventType: OUTBOX_GRANT_ACCESS, payload: { subscriptionId } })`. Write an `activity_log` row either way.
5. Return `{ subscriptionId }` — `null` for a rejection.

**Rejection sends nothing.** No outbox row, no message. That is the design, not an omission.

- [ ] **Step 1: Write the failing tests.** Cover, at minimum: approve creates an `active` subscription with a null `next_billing_date` and enqueues exactly one `grant_access` row; **approving twice enqueues exactly one** `grant_access` row and the second call 409s; reject enqueues **nothing** and sends nothing; a creator who does not own the community gets **404, not 403**; a request whose id belongs to another community gets 404; a request whose tier was deactivated gets 409; both decisions write an `activity_log` row.

- [ ] **Step 2: Write the failing route tests** — `GET …/join-requests` lists pending requests for the owner and 404s for a stranger; both `POST` routes return 200 for the owner and 404 for a stranger.

- [ ] **Step 3: Run them and confirm they fail.**

- [ ] **Step 4: Implement and wire the routes.**

- [ ] **Step 5: Root gates, then commit** `"feat(members): let an owner approve or reject a join request"`.

---

### Task 5: Telling the owner a request arrived

**Files:**
- Create: `apps/api/src/application/use-cases/notify-join-request.ts` + `.test.ts`
- Modify: `apps/api/src/worker-bootstrap.ts`
- Modify: `apps/api/src/application/ports/join-request-repository.port.ts` (a lookup for the notification's context)

**Interfaces:**
- Consumes: `OUTBOX_NOTIFY_JOIN_REQUEST` (Task 3).
- Produces: a worker handler registered exactly as `notifyStreamLiveOutboxHandler` is, around `worker-bootstrap.ts:283`.

**`creator.whatsapp_number` is nullable.** When it is absent the row must be **consumed and recorded, not retried forever** — a creator who never set a number would otherwise generate a permanently failing row on every single join request. Treat it the way `GrantChannelAccess` treats a platform it cannot gate: record the fact and move on. The dashboard list in Task 7 is the real fallback, which is why it is not optional.

The message, in Bahasa Indonesia:

```
Permintaan bergabung baru di {communityName}: {memberName} ingin bergabung ke tier {tierName}. Setujui atau tolak di dasbor DIUDARA.
```

Do not put the member's WhatsApp number in the message — it adds nothing the dashboard does not show, and it puts a second person's number into a third-party messaging provider's logs.

- [ ] **Step 1: Write the failing tests** — sends one message to the creator's number with the community, member and tier names in it; when the creator's number is null, sends **nothing** and the row is **not** retried; a join request that no longer exists is consumed rather than retried forever.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement, and register the handler** in `worker-bootstrap.ts` beside the existing ones.

- [ ] **Step 4: Root gates, then commit** `"feat(worker): notify an owner when someone asks to join"`.

---

### Task 6: The member's side of the web

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/pages/CheckoutPage.tsx` + test
- Create: `apps/web/src/pages/RequestStatusPage.tsx` + test
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `accessMode` on `PublicCommunity`; `POST /c/:slug/join-request`; `GET /c/:slug/request/:id`.
- Produces: the route `/c/:slug/request/:joinRequestId`.

Add to `api.ts`, following `startCheckout` exactly:

```ts
export interface JoinRequestResult { joinRequestId: string }
export async function submitJoinRequest(
  slug: string,
  input: JoinRequestInput
): Promise<JoinRequestResult>;

export interface JoinRequestStatus {
  status: string;
  communitySlug: string;
  subscriptionId: string | null;
}
export async function fetchJoinRequestStatus(
  slug: string,
  joinRequestId: string
): Promise<JoinRequestStatus>;
```

**Free tiers need no schema or validation change** — `createTierSchema` already validates `priceAmount` as `z.number().int().min(0)`, so a tier priced at 0 is accepted today. Do not "fix" that; it is not broken.

**`CheckoutPage` branches on `accessMode`.** Under `request` it renders the same name and WhatsApp fields with a different heading, button and outcome; **when there is exactly one active tier it is selected automatically and no tier picker is shown** — a free community with one tier must not ask a question with one answer. No prices are rendered in `request` mode.

Copy:

- heading: `"Ajukan bergabung"`
- button: `"Kirim permintaan"`
- after submit, redirect to `/c/:slug/request/:joinRequestId`

**`RequestStatusPage`** renders one of three states:

- `pending` — `"Permintaan Anda sudah dikirim dan menunggu persetujuan pemilik komunitas. Anda akan menerima tautan undangan grup lewat WhatsApp setelah disetujui."`
- `approved` — `"Permintaan Anda disetujui. Cek WhatsApp Anda untuk tautan undangan grup."` **plus a link to `/c/:slug/status/:subscriptionId`**, which is where live streams are reached. Without that link an approved free member has no route to "Tonton sekarang".
- `rejected` — `"Permintaan Anda belum dapat disetujui saat ini."` Do not invent a reason; the owner never gave one.

- [ ] **Step 1: Write the failing tests** — `CheckoutPage` renders the purchase form when `accessMode` is `paid` and the request form when it is `request`; the request form shows **no** price and **no** tier picker when there is exactly one tier; a tier picker appears with two tiers; `RequestStatusPage` renders each of the three states, and the `approved` state renders exactly one link to the subscription status page.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement, and add the route to `App.tsx`** beside `/c/:slug/status/:subscriptionId`.

- [ ] **Step 4: Root gates, then commit** `"feat(web): let a member ask to join a free community"`.

---

### Task 7: The owner's pending list

**Files:**
- Modify: `apps/web/src/dashboard/pages/MembersPage.tsx` + test
- Modify: `apps/web/src/dashboard/apiClient.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `GET /communities/:communityId/join-requests` and both decision endpoints.

A **Permintaan bergabung** section above the existing roster, rendered only when the community's `accessMode` is `request`. Each row shows the member's name, WhatsApp number, tier and how long it has been waiting, with **Setujui** and **Tolak** buttons. A heading count (`Permintaan bergabung (3)`) so it is visible without scrolling.

**Reject asks for confirmation; approve does not.** Approval is recoverable — the owner can revoke the member afterwards through the existing flow. Rejection is silent and the member is never told, so a mis-tap is invisible to everyone. Follow the existing `data-testid="revoke-confirm"` confirmation pattern already in this file.

After either decision, remove the row and refresh the roster, so an approved member appears as a member without a manual reload.

- [ ] **Step 1: Write the failing tests** — the section renders pending requests and is **absent** when `accessMode` is `paid`; approving removes the row and refreshes the roster; rejecting asks for confirmation first and does nothing if dismissed; a 409 (already decided in another tab) shows a message and refreshes rather than leaving a stale row. Count elements or assert booleans — never `expect(<DOM element>).toBeNull()`.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Root gates, then commit** `"feat(web): show an owner their pending join requests"`.

---

### Task 8: End-to-end verification and the phase gate

Not a coding task. **Fix whatever it surfaces.**

- [ ] Root `bun run test` and `bun run typecheck` green.
- [ ] Kill stale Vite, API, worker and Postgres processes first; start everything fresh.
- [ ] **With both Xendit keys unset and `NODE_ENV=production`, confirm the API boots**, `GET /c/:slug` works, and `POST /c/:slug/checkout` returns **404**. This is the whole point of Task 2 and cannot be proven by a unit test alone.
- [ ] **In a real browser, recording actual output:**
  1. create a community, set it to `request`, add one tier
  2. from a second browser context, submit a join request
  3. confirm the owner's dashboard shows it, and that the `notify_join_request` outbox row was consumed
  4. approve it; confirm an `active` subscription exists with a **null** `next_billing_date`, an `activity_log` row was written, and exactly one `grant_access` row was enqueued
  5. confirm the member's request page flips to `approved` and links to their subscription status page
- [ ] **Confirm rejection sends nothing** — no outbox row, no message — and that the same member can then submit a **new** request.
- [ ] **Confirm a `paid` community 404s the request route** even with payments disabled. This is the giveaway the spec exists to prevent; prove it rather than assuming it.
- [ ] **Confirm a duplicate submit produces one row**, by submitting twice concurrently rather than sequentially — the point is that the unique index arbitrates, not the read.
- [ ] Confirm the existing paid flow is **unchanged** with Xendit keys set: checkout still returns an invoice URL, and the existing tests still pass untouched.
- [ ] Run the full suite **3 times**; no flakes. Three `apps/api` timestamp-precision flakes are known and named in `docs/` — `process-renewals.test.ts:263`, `drizzle-channel-membership.repository.test.ts:219`, `drizzle-subscription.repository.test.ts:1110` — all comparing `updatedAt` against `createdAt` and missing by 2-3 ms. If one of those appears, record it and re-run; if anything **else** appears, capture which test and what error.
