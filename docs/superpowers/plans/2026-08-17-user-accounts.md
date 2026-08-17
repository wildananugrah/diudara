# User Accounts, Profiles and Handles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can sign up, log in, own a handle, edit a profile visible at `/@wildan`, and recover a forgotten password by email or WhatsApp.

**Architecture:** A new `app_user` table entirely independent of `creator` and `member`, reusing the existing argon2id hasher and the hono/jwt issuer with a **different type claim**, so the two session kinds can never be swapped. Password reset is a hashed, single-use token delivered over a new `EmailProviderPort` or the existing `MessagingProviderPort`.

**Tech Stack:** Postgres + Drizzle, Bun + Hono (ports and adapters), Vite + React, `bun:test`.

## Global Constraints

From `docs/superpowers/specs/2026-08-17-user-accounts-design.md`.

- **Nothing migrates.** `creator` and `member` are untouched; both existing login paths keep working. The two systems do not know about each other.
- **The table is `app_user`, not `user`.** `user` is a reserved SQL keyword requiring quotes in every hand-written query, and this project debugs through `psql` constantly.
- **Handles are lowercase `[a-z0-9_]`, 3-30 chars, unique, and set once.** Stored and compared lowercase, so `@Wildan` and `@wildan` are the same person and only one can exist.
- **The `@` is a web URL convention only.** API routes take a bare handle. Never put `@` in a database value or an API path segment.
- **The user token carries `typ: "user"`**; the creator token carries `typ: "creator"`. Both are signed with `JWT_SECRET`, so that claim is the *only* separation between them.
- **No avatar, no image upload.** That needs the Phase 4 pipeline.
- **Enumeration safety is a requirement, not a nicety.** Signup with an existing email answers as though it succeeded; login gives one message for every failure; a reset request answers identically whether or not the account exists.
- **Reset tokens are random, stored hashed, single-use, 30-minute expiry.** Using one invalidates every other outstanding token for that user, and completing a reset ends all existing sessions.
- **Absent provider configuration disables that channel and does not block boot; partial configuration throws in every environment.** This is the codebase's established rule — see `selectMessagingProviders` and `selectPaymentProvider`.
- **All user-facing copy in Bahasa Indonesia.**
- A failing `expect(<DOM element>).toBeNull()` **hangs `bun test`** (~178 s, 335 MB); there is a source-scan guard at `apps/web/src/test/no-hanging-dom-assertions.test.ts`. Count elements or assert booleans.
- Migrations are **Drizzle-generated only**: edit `apps/api/src/db/schema.ts`, then `bun run db:generate`. Never hand-write a file in `apps/api/drizzle/`.
- Root gates: `bun run test` and `bun run typecheck` from the repo root — **`bun run test`, never bare `bun test`**, which produces ~123 spurious failures because `apps/web` needs its own bunfig preload. Baseline: 2020 pass / 0 fail.

---

### Task 1: The `app_user` table, handle rules, and the repository

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/00XX_*.sql` (generated)
- Create: `apps/api/src/domain/handle.ts` + `.test.ts`
- Create: `apps/api/src/application/ports/user-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-user.repository.ts` + `.test.ts`

**Interfaces:**
- Produces: `UserRepositoryPort`, `UserRecord`, `normalizeHandle`, `isValidHandle`. Tasks 2-5 consume these.

**Schema:**

```ts
export const appUsers = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    handle: varchar("handle", { length: 30 }).notNull().unique(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    // Nullable: offered at signup, not required. A user without one has
    // exactly one reset channel — see the spec's §5.
    whatsappNumber: varchar("whatsapp_number", { length: 32 }),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    bio: varchar("bio", { length: 300 }),
    // Bumped by a completed password reset. The token carries the value it
    // was issued under and `requireUserAuth` compares — which is what makes
    // "a reset ends all sessions" possible at all, since a JWT is stateless
    // and cannot otherwise be revoked short of rotating JWT_SECRET.
    sessionEpoch: integer("session_epoch").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
```

**`handle` and `email` are both stored already-normalised** — lowercase, trimmed — so the plain unique index is the whole defence. Do not add a functional index on `lower(...)`; normalise on the way in instead, exactly as `normalizeEmail` already does for creators.

**The domain module:**

```ts
/** 3-30 chars, lowercase letters, digits and underscore. */
export const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;
/** Trim, strip a leading `@` if a caller passed one, lowercase. */
export function normalizeHandle(raw: string): string;
export function isValidHandle(normalised: string): boolean;
```

`normalizeHandle` strips a leading `@` deliberately: the web URL shows one, and a caller pasting `@wildan` into an API field should not be punished for it. The database never stores one.

**The port:**

```ts
export interface UserRecord {
  id: string;
  handle: string;
  email: string;
  whatsappNumber: string | null;
  displayName: string;
  bio: string | null;
  sessionEpoch: number;
  createdAt: Date;
}

export interface UserCredentials {
  id: string;
  passwordHash: string;
  sessionEpoch: number;
}

export interface UserRepositoryPort {
  /** Rejects with `UniqueViolationError` naming which of handle/email collided. */
  create(input: {
    handle: string;
    email: string;
    whatsappNumber: string | null;
    passwordHash: string;
    displayName: string;
  }): Promise<UserRecord>;
  findByHandle(handle: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  /** The ONLY path that returns a hash. `findBy*` deliberately never do. */
  findCredentialsByEmail(email: string): Promise<UserCredentials | null>;
  updateProfile(id: string, patch: { displayName?: string; bio?: string | null }): Promise<UserRecord | null>;
  setPasswordAndBumpEpoch(id: string, passwordHash: string): Promise<boolean>;
}
```

`create` maps the unique violation with the existing `rethrowUniqueViolation` helper in `pg-errors.ts`, exactly as `DrizzleCreatorRepository.create` does — that helper exists so the raw driver error, which carries bound parameters including the hash, is never re-exposed. Map each constraint separately so the caller can tell handle from email.

- [ ] **Step 1: Write the failing domain tests.** `normalizeHandle` trims, strips one leading `@`, lowercases; `isValidHandle` accepts `wil_dan_99` and `abc`, rejects `ab` (too short), a 31-char handle, `wildan!`, `Wildan` (must already be normalised), and the empty string.

- [ ] **Step 2: Write the failing repository tests.** `create` returns a record and never returns `passwordHash`; a second `create` with the same handle rejects naming the handle; the same with a duplicate email rejects naming the email; `findByHandle` is exact-match on the normalised value; `findCredentialsByEmail` returns the hash while `findByEmail` does not; `updateProfile` can set a bio and can clear it to `null`; `setPasswordAndBumpEpoch` increments `session_epoch` by exactly one and returns `false` for an unknown id.

- [ ] **Step 3: Add a concurrency test.** Two simultaneous `create` calls for the same handle produce **one** user — the unique index arbitrates, not a prior read. Use the `ArrivalLatch` helper the codebase already uses for `markPastDue`'s concurrency test.

- [ ] **Step 4: Run them and confirm they fail** — `cd apps/api && bun test src/domain/handle.test.ts src/infrastructure/repositories/drizzle-user.repository.test.ts`. Expected: missing-module errors.

- [ ] **Step 5: Edit `schema.ts`, then `cd apps/api && bun run db:generate && bun run db:migrate`.** Inspect the generated SQL and confirm the table is `app_user` and both unique indexes exist. If not, fix the schema and regenerate — never edit the SQL.

- [ ] **Step 6: Implement the domain module, the port and the repository.**

- [ ] **Step 7: Root gates, then commit** `"feat(users): add the app_user table, handle rules and repository"`.

---

### Task 2: Signup, login, and a token that cannot be confused with a creator's

**Files:**
- Create: `apps/api/src/application/ports/user-token-issuer.port.ts`
- Create: `apps/api/src/infrastructure/auth/hono-jwt.user-token-issuer.ts` + `.test.ts`
- Create: `apps/api/src/application/use-cases/register-user.ts` + `.test.ts`
- Create: `apps/api/src/application/use-cases/authenticate-user.ts` + `.test.ts`
- Create: `apps/api/src/http/user-auth.middleware.ts` + `.test.ts`
- Create: `apps/api/src/routes/users.ts` + `.test.ts`
- Modify: `packages/shared/src/auth.schema.ts`, `apps/api/src/bootstrap.ts`, `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `UserRepositoryPort`, `normalizeHandle` (Task 1).
- Produces: `UserTokenIssuerPort`, `requireUserAuth`, `POST /users/signup`, `POST /users/login`.

**The token payload carries the epoch:**

```ts
export interface UserTokenPayload {
  userId: string;
  sessionEpoch: number;
}
export interface UserTokenIssuerPort {
  issue(payload: UserTokenPayload): Promise<string>;
  verify(token: string): Promise<UserTokenPayload | null>;
}
```

The adapter mirrors `HonoJwtTokenIssuer` exactly, with `const TOKEN_TYPE = "user"` instead of `"creator"`, and **`verify` must reject a token whose `typ` is not `"user"`**. Check the existing issuer: it treats a **missing `exp` as invalid** rather than as "never expires", because `hono/jwt` only validates `exp` when present. Keep that behaviour.

**`requireUserAuth` sets `userId`, and re-reads the user to compare `sessionEpoch`.** A token issued before a password reset must stop working — that comparison is the entire mechanism, and skipping it silently makes "a reset ends all sessions" a lie.

**Schemas** in `packages/shared/src/auth.schema.ts`:

```ts
export const userSignupSchema = z.object({
  handle: z.string().trim().min(1).max(31),
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(255),
  // Same tolerant Indonesian-number rule `startCheckoutSchema` already uses.
  whatsappNumber: z.string().trim().min(8).max(20).regex(/^[+0-9][0-9]{7,19}$/).optional(),
});
export const userLoginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(200),
});
```

`handle` allows 31 characters at the schema layer so a leading `@` survives validation and is stripped by `normalizeHandle`; the domain rule then enforces 3-30 on the normalised value.

**`RegisterUser` — and the enumeration rule that dictates its shape:**

```ts
execute(input: {...}): Promise<{ ok: true }>
```

**It returns no user and no token, and signup does not log you in.** That is forced, not stylistic. Enumeration safety requires a duplicate email to be indistinguishable from a fresh one — and if signup returned a session, the duplicate case would have to return a session *for an account the caller does not own*. Returning nothing is the only shape where "answer identically" is also safe. The UI therefore says `"Akun dibuat. Silakan masuk."` and sends them to the login page.

A duplicate **handle** *does* throw `ConflictError`. A handle is public by design — anyone can check `/@wildan` — so saying it is taken leaks nothing that browsing does not.

Comment that asymmetry at the code, or the next reader will "fix" it into a hole.

**`AuthenticateUser`** copies `AuthenticateCreator`'s structure exactly, including `DUMMY_PASSWORD_HASH` and the comment explaining it: always pay the argon2id cost so response time is not an oracle. One `GENERIC_FAILURE` message for every failure.

- [ ] **Step 1: Write the failing tests.** Issuer: round-trips a payload; rejects a token with `typ: "creator"`; rejects a missing `exp`. Middleware: rejects no header, a malformed header, a creator token, and **a token whose `sessionEpoch` is behind the user's**. `RegisterUser`: creates a user, normalises the handle, rejects a duplicate handle with 409, and **returns success-shaped output for a duplicate email**. `AuthenticateUser`: succeeds; gives the identical error for unknown email and wrong password.

- [ ] **Step 2: Write the failing cross-audience test.** A **creator** token is rejected by `requireUserAuth`, and a **user** token is rejected by the existing `requireAuth`. Both directions, in one test file, because this is the only thing separating the two session kinds.

- [ ] **Step 3: Run them and confirm they fail.**

- [ ] **Step 4: Implement**, and wire `POST /users/signup` and `POST /users/login` in `routes/users.ts`, mounted in `app.ts`. Note `bootstrap.ts` builds `Dependencies` but does **not** mount routes — mounting is `app.ts`.

- [ ] **Step 5: Root gates, then commit** `"feat(users): sign up, log in, and a user-scoped session token"`.

---

### Task 3: Profiles — read and edit

**Files:**
- Create: `apps/api/src/application/use-cases/get-user-profile.ts` + `.test.ts`
- Create: `apps/api/src/application/use-cases/update-user-profile.ts` + `.test.ts`
- Modify: `apps/api/src/routes/users.ts` + `.test.ts`, `packages/shared/src/auth.schema.ts`

**Interfaces:**
- Consumes: `UserRepositoryPort`, `requireUserAuth`.
- Produces: `GET /users/by-handle/:handle`, `GET /users/me`, `PATCH /users/me`.

**`/users/by-handle/:handle` takes a bare handle — no `@`.** The `@` is a web URL convention; putting it in an API path means every caller must encode it and every log line carries it. `normalizeHandle` still strips one if a client sends it, so a mistake is forgiving rather than a 404.

**The public profile is an explicit projection**, never a spread:

```ts
export interface PublicUserProfile {
  handle: string;
  displayName: string;
  bio: string | null;
  createdAt: Date;
}
```

**It must not include `email`, `whatsappNumber`, `id` or `sessionEpoch`.** Anyone can fetch any profile by handle; leaking an email there would be worse than the account-enumeration leaks the rest of this phase carefully avoids. `GET /users/me` returns more — email and WhatsApp number — because it is the authenticated user's own record.

**The patch schema:**

```ts
export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255).optional(),
    // Explicit null clears the bio; absent leaves it alone.
    bio: z.string().trim().max(300).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "at least one field is required",
  });
```

**Handle is deliberately absent from the patch.** Handles are set once (spec §3.2). If a request includes one, Zod strips it silently — which is the behaviour that hid a Critical in the previous phase, so add an explicit test that `PATCH { handle: "other" }` alone is a 400 and does **not** change the handle.

- [ ] **Step 1: Write the failing tests.** Public profile returns exactly the four fields and no email; an unknown handle 404s; a handle sent with a leading `@` still resolves; `GET /users/me` requires auth and includes email; `PATCH /users/me` updates a display name, clears a bio with explicit `null`, rejects an empty patch with 400, and **cannot change the handle**.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement and wire the three routes.**

- [ ] **Step 4: Root gates, then commit** `"feat(users): public profiles and profile editing"`.

---

### Task 4: The email provider

**Files:**
- Create: `apps/api/src/application/ports/email-provider.port.ts`
- Create: `apps/api/src/infrastructure/email/resend-email.adapter.ts` + `.test.ts`
- Create: `apps/api/src/infrastructure/email/fake-email.adapter.ts` + `.test.ts`
- Modify: `apps/api/src/bootstrap.ts` + `.test.ts`, `apps/api/.env.example`, `CONTRIBUTING.md`

**Interfaces:**
- Produces: `EmailProviderPort`, `selectEmailProvider`. Task 5 consumes both.

```ts
export interface SendEmailInput {
  to: string;
  subject: string;
  /** Plain text only. HTML mail is a rendering and deliverability project of its own. */
  body: string;
}
export interface EmailProviderPort {
  send(input: SendEmailInput): Promise<void>;
}
```

**`ResendEmailAdapter` uses `fetch` against Resend's HTTP API — no new dependency**, exactly as `XenditPaymentAdapter` does for payments. Inject `fetchFn` in the constructor the same way, so it is testable without a network.

**`selectEmailProvider` follows the established rule**, and the plan states it explicitly because getting this wrong is how a previous phase shipped a Critical:

| `RESEND_API_KEY` | `EMAIL_FROM` | `NODE_ENV` | Result |
|---|---|---|---|
| both set | | any | `ResendEmailAdapter` |
| exactly one set | | any | **Throws**, every environment |
| neither | | `development` / `test` | `FakeEmailAdapter` |
| neither | | anything else | **Returns `null`** — email is disabled, boot continues |

Read `selectMessagingProviders` before writing this and copy its shape; do not invent a new one.

- [ ] **Step 1: Write the failing adapter tests.** `send` POSTs to Resend's endpoint with the API key in the `Authorization` header and the right JSON body; a non-2xx response throws with a message that does **not** include the API key; the injected `fetchFn` is what is called.

- [ ] **Step 2: Write the failing selector tests** — one per row of the table above, asserting the disabled case is `null` **and not an instance of `FakeEmailAdapter`**. Assert the negative, not just the null: a future refactor that "helpfully" falls back would satisfy a loose null check.

- [ ] **Step 3: Run them and confirm they fail.**

- [ ] **Step 4: Implement, and document the two variables** in `.env.example` and `CONTRIBUTING.md` beside the other provider groups.

- [ ] **Step 5: Root gates, then commit** `"feat(email): add an email provider port and Resend adapter"`.

---

### Task 5: Password reset

**Files:**
- Modify: `apps/api/src/db/schema.ts` (+ generated migration)
- Create: `apps/api/src/application/ports/password-reset-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-password-reset.repository.ts` + `.test.ts`
- Create: `apps/api/src/domain/reset-token.ts` + `.test.ts`
- Create: `apps/api/src/application/use-cases/request-password-reset.ts` + `.test.ts`
- Create: `apps/api/src/application/use-cases/complete-password-reset.ts` + `.test.ts`
- Modify: `apps/api/src/routes/users.ts` + `.test.ts`, `packages/shared/src/auth.schema.ts`

**Interfaces:**
- Consumes: `UserRepositoryPort.setPasswordAndBumpEpoch`, `EmailProviderPort`, `MessagingProviderPort`.
- Produces: `POST /users/password-reset/request`, `POST /users/password-reset/complete`.

**The table:**

```ts
export const passwordResetTokens = pgTable(
  "password_reset_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => appUsers.id),
    // sha256 of the token that was sent. NEVER the token itself — a database
    // read must not yield a working reset link.
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    // Hashed, for the per-IP rate limit. Storing raw addresses against a
    // password-reset request is more PII than this feature needs.
    requestIpHash: varchar("request_ip_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("password_reset_user_created_idx").on(table.userId, table.createdAt),
    index("password_reset_ip_created_idx").on(table.requestIpHash, table.createdAt),
  ],
);
```

Those two indexes exist for the rate-limit counts. Without them each reset request seq-scans the table — the same defect a previous phase found in the renewal passes.

**The domain module:**

```ts
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
/** 32 random bytes, hex. Not a uuid: uuids are for identifiers, not secrets. */
export function mintResetToken(): { token: string; tokenHash: string };
export function hashResetToken(token: string): string;
```

**`RequestPasswordReset` — the shape is dictated by enumeration safety:**

1. Normalise the email, look the user up.
2. **If no user, return the same success result and send nothing.** No throw, no different status, no different timing that a caller could measure at scale.
3. Rate-limit: refuse if this user has more than **3** requests in the last hour, or this IP hash more than **10**. Refusal returns the *same* success-shaped result — a rate-limit message would itself be an oracle.
4. Choose the channel: `email` if configured, `whatsapp` if the user has a number and messaging is configured. If **neither**, return success-shaped output and record nothing.
5. Mint a token, store only its hash with a 30-minute expiry.
6. Send the link — `{appBaseUrl}/reset/{token}` — over the chosen channel.

**`CompletePasswordReset`:**

1. Hash the presented token, look it up.
2. Refuse if missing, expired, or already used — **one message for all three**.
3. In one transaction: mark this token used, mark **every other** outstanding token for that user used, and `setPasswordAndBumpEpoch`.

That epoch bump is what ends existing sessions. Without it the reset is cosmetic and whoever stole the password stays logged in.

- [ ] **Step 1: Write the failing domain tests.** `mintResetToken` returns 64 hex chars and a matching hash; two mints never collide; `hashResetToken` is stable.

- [ ] **Step 2: Write the failing use-case tests.** Unknown email returns success-shaped output and sends **nothing**; a known email sends exactly one message; the token stored is a **hash**, and the plaintext appears nowhere in the row; over-limit requests return the same shape and send nothing; a user with no number and no email provider produces no send; completing a reset sets the password, bumps the epoch by one, marks the token used, and marks a **second** outstanding token used; an expired, reused or unknown token gives one identical error.

- [ ] **Step 3: Write the failing session test.** Issue a token, complete a reset, and confirm the **old** token is now rejected by `requireUserAuth`. This is the assertion that proves the epoch mechanism works end to end; everything else about it is bookkeeping.

- [ ] **Step 4: Run them and confirm they fail.**

- [ ] **Step 5: Generate the migration, implement, wire both routes.**

**One more sender, small but required by the spec:** when signup hits an existing email, the account's owner is told *someone tried to sign up with your address* over whichever channel they have. That is what makes the silent duplicate honest rather than merely quiet — the person who owns the address learns about it, while the person who typed it learns nothing. It lives here rather than in Task 2 because it needs a channel to exist.

Copy: `"Seseorang mencoba mendaftar dengan alamat email ini. Jika itu Anda, silakan masuk atau pulihkan sandi Anda."`

- [ ] **Step 6: Write the failing test for that notice** — a signup against an existing email sends exactly one message to that account's channel, and the HTTP response is byte-identical to a fresh signup's.

- [ ] **Step 7: Root gates, then commit** `"feat(users): password reset over email or WhatsApp"`.

**Review addendum (post-implementation, Task 5 code review) — the spec above is left as originally written; this records where the SHIPPED behaviour now diverges from it, and why:**

- **Step 6's send, and `RequestPasswordReset`'s own send (step 6 of ITS list), are NOT awaited by their callers.** Measured: an awaited real provider call made a found-and-sent password-reset response ~290x slower than a no-such-user response (215ms), and made a duplicate-email signup ~4.5x slower than a fresh one (231ms) — both exploitable, one-request-and-a-stopwatch timing oracles for account/email existence. The mint-and-store (or rate-limit-check-and-record) step stays awaited — it is a fast local write and is what the rate limit actually reads — but the external network call is fired without an `await`. **Deliberately NOT moved onto the outbox**, despite that being this codebase's usual pattern for exactly this kind of deferral (`SendRenewalReminder`, `NotifyJoinRequest`): the outbox persists its payload in a `jsonb` column, and this feature's own hard rule — "a database read must not yield a working reset link" — would be violated by a plaintext token sitting in an outbox row for however long it is queued. `GrantChannelAccess`'s "mint the credential at delivery time, outbox carries only ids" pattern does not resolve this either: it would mean minting a SECOND, real token in the worker and leaving the first an inert, never-sent decoy, for no correctness gain over simply not awaiting the send.
- **The per-IP rate limit (step 3's "or this IP hash more than 10") is REMOVED, not merely fixed.** `X-Forwarded-For`'s leftmost entry is client-supplied, and this repository has no committed nginx configuration for the general `/users/...` API surface proving anything ever overwrites it — `infra/nginx/live-hls.conf.template` is a fragment scoped to `/live/`, `/whip/` and `/webhooks/mediamtx/` only. A limit keyed on an untrusted, caller-controlled value is not a limit. Only the per-account cap (3/hour) is enforced now. `requestIpHash` is still captured (from the LAST `X-Forwarded-For` entry, not the first) and stored for forensic/audit value, never to gate a decision. Dropping the per-IP cap also closes a review finding of its own: because `password_reset_token.user_id` is `NOT NULL`, only a real account's request could ever produce a row, so the (formerly enforced) shared per-IP counter let an attacker read whether some OTHER email exists by watching their own IP's count climb only on hits.
- **The existing-email signup notice (Task 5's "one more sender") now has its own rate limit — a NEW `signup_notice` table, not in the schema above.** Unrate-limited, it was measured to let 25 signup attempts against one address deliver 25 messages, all 201: a free amplification channel (paid WhatsApp sends, or an inbox flood) triggerable by anyone who knows a victim's email, with no cap at all — worse than the reset endpoint's own limit. Capped at 3/hour/account in a table separate from `password_reset_token`, so exhausting it cannot also block the real owner's own password-reset requests.
- **The 30-minute expiry is now pinned by a test that hardcodes the literal `30 * 60 * 1000`**, independent of importing `RESET_TOKEN_TTL_MS` — a mutation that changed the OFFSET actually applied when writing a token's `expiresAt` (leaving the constant's own definition untouched) previously passed the whole suite.

---

### Task 6: The web

**Files:**
- Create: `apps/web/src/user/apiClient.ts` + `.test.ts`
- Create: `apps/web/src/user/SignupPage.tsx`, `LoginPage.tsx`, `ProfilePage.tsx`, `SettingsPage.tsx`, `ResetRequestPage.tsx`, `ResetCompletePage.tsx` (+ a `.test.tsx` each)
- Modify: `apps/web/src/App.tsx`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: every endpoint from Tasks 2, 3 and 5.

**Routes:**

| Path | Page |
|---|---|
| `/signup` | SignupPage |
| `/masuk` | LoginPage |
| `/pengaturan` | SettingsPage (requires a session) |
| `/lupa-sandi` | ResetRequestPage |
| `/reset/:token` | ResetCompletePage |
| `/:handleParam` | ProfilePage — **must be the last route before the 404 catch-all** |

**The profile route needs care, and this is the one thing in this task that will go wrong if skimmed.** React Router cannot mix a literal and a parameter inside one segment, so `path="/@:handle"` does **not** match `/@wildan`. Use `path="/:handleParam"`, and have `ProfilePage` render the 404 page unless the param starts with `@`. Strip the `@` before calling the API.

Registering it last matters: a single-segment dynamic route would otherwise shadow `/signup` and `/masuk`. React Router ranks static segments above dynamic ones, so ordering is defensive rather than load-bearing — but test it, because the failure is that your own login page stops resolving.

**Session storage:** keep the token exactly the way the existing dashboard client does — read `apps/web/src/dashboard/apiClient.ts` and follow it, including its `SESSION_EXPIRED_MESSAGE` handling on 401. Do not invent a second scheme.

**Copy, all Indonesian:**

- Signup: heading `"Buat akun"`, button `"Daftar"`, the WhatsApp field labelled `"Nomor WhatsApp (opsional)"` with the hint `"Untuk memulihkan sandi dan memberi tahu Anda saat ada siaran langsung."`
- Login: heading `"Masuk"`, button `"Masuk"`, link `"Lupa sandi?"`
- Reset request: `"Kami akan mengirim tautan pemulihan jika akun dengan data tersebut ada."` — **that wording is deliberate**; it must be true whether or not the account exists.
- Reset complete: on an invalid or expired token, `"Tautan ini sudah tidak berlaku. Silakan minta tautan baru."`
- Profile of an unknown handle: the existing 404 page, with no hint that the handle is free.

- [ ] **Step 1: Write the failing tests.** Signup submits and lands on the login page with `"Akun dibuat. Silakan masuk."` (it does **not** log you in — see Task 2 for why); a duplicate handle shows the 409 message; a **duplicate email shows that same success screen** (matching the API's enumeration behaviour — assert this explicitly, it looks like a bug otherwise); login stores a session and redirects; the profile page renders a display name, handle and bio, and a bio-less profile renders without an empty element; `/@nosuchuser` renders the 404 page; settings updates a display name; the reset request page shows the same message for any input; the reset complete page shows one message for an invalid token. Count elements or assert booleans — never `expect(<DOM element>).toBeNull()`.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement, and add the routes to `App.tsx` in the order above.**

- [ ] **Step 4: Root gates, then commit** `"feat(web): signup, login, profiles and password reset"`.

---

### Task 7: End-to-end verification and the phase gate

Not a coding task. **Fix whatever it surfaces.**

- [ ] Root `bun run test` and `bun run typecheck` green.
- [ ] Kill stale Vite, API and worker processes; start fresh.
- [ ] **In a real browser, recording actual output:**
  1. sign up, confirm the user row exists in Postgres with a **lowercase** handle and an argon2id hash
  2. log out, log in, reach `/pengaturan`
  3. set a display name and a bio, then clear the bio
  4. open `/@yourhandle` in a **logged-out** browser and confirm it renders — and that the response body contains **no email address**
  5. request a password reset, complete it, and confirm **the session from step 2 is now rejected**
- [ ] **Confirm the two account systems do not interfere:** a creator token is refused by `/users/me`, a user token is refused by `/communities`, and the creator dashboard still logs in and works.
- [ ] **Confirm enumeration safety by observation**, not by reading the code: signing up with an existing email and with a fresh one produce the same visible outcome, and a reset request for a known and an unknown address produce the same response body and status.
- [ ] **Confirm the reset token is never stored in plaintext** — `select token_hash from password_reset_token;` must not contain the value from the link you clicked.
- [ ] **Boot with no email provider configured and `NODE_ENV=production`**: the API starts, and a reset request for a user with a WhatsApp number still works while one for a user without falls back to the "no channel" message.
- [ ] Run the full suite **3 times**; no flakes. Five sightings are recorded in `docs/`, four of them timestamp-precision comparisons between an app-side and a database-side clock. If a new one appears, **capture the full output** — that has only been managed once.
