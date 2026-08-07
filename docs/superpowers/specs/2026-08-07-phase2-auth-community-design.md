# Phase 2: Creator Auth & Community Setup — Design Spec

Date: 2026-08-07
Status: Approved for planning
Parent spec: `docs/superpowers/specs/2026-08-07-diudara-mvp-design.md`
Builds on: Phase 1 (Foundation), merged to `main` at commit `d0904b8`

## 1. Purpose

Phase 2 gives DIUDARA its first real users and first real data. A creator can register,
log in, and set up a community: define its paid membership tiers and connect the
WhatsApp/Telegram channel that will later be gated behind payment.

Nothing in this phase charges money, sends a message, or talks to an external provider —
those are Phases 3 and 4. This phase's job is the authenticated CRUD foundation they need,
plus the HTTP conventions (validation, error mapping, authorization) that every later route
will follow.

## 2. Scope

**In scope:**
- Creator registration and login (email + password, JWT sessions)
- Community create / list / update, with shareable slugs
- Membership tier create / list / update
- Channel connect / list (storing the platform + external group id; no bot API calls yet)
- `packages/shared` — Zod schemas and inferred types shared with the future frontend
- HTTP conventions: Zod validation middleware, `app.onError` domain-error mapping,
  auth middleware, per-route narrow dependency types

**Out of scope (deferred, with the phase that owns them):**
- Frontend dashboard UI — its own later phase
- Password reset, email verification, login rate limiting — a hardening pass
- Actual WhatsApp/Telegram bot connection and invite-link generation — Phase 4
- Payments, checkout, subscriptions — Phase 3
- AI-assisted community setup — Phase 7

## 3. Decisions settled during brainstorming

| Question | Decision | Reason |
|---|---|---|
| WA number required at signup? | No — `whatsapp_number` becomes nullable | Signup asks name + email + password only; fewer fields, and WA isn't needed until Phase 4 |
| Community URLs | Auto-generated slug from name, creator-editable | Checkout links get broadcast to WhatsApp audiences; readability matters |
| Sessions | Stateless JWT, 7-day expiry | No session table or refresh-token machinery; logout is client-side discard |
| Frontend in this phase? | No, backend API only | Keeps the phase reviewable; UI built once enough endpoints exist to be coherent |
| `packages/shared` now? | Yes | Phase 2 defines the first real request/response shapes — the natural moment |

## 4. Schema changes

One generated Drizzle migration:

- `creator.password_hash` — varchar, **nullable**. Nullable rather than NOT NULL because
  later phases may create creators without a password (Phase 7 AI onboarding, or a future
  WA-OTP path). The login use-case rejects a null-hash account explicitly; the database
  does not forbid the state.
- `creator.whatsapp_number` — **relaxed to nullable** (was NOT NULL).
- `community.slug` — varchar, **NOT NULL, UNIQUE**.

Everything else in the Phase 1 schema is untouched.

## 5. Architecture

Follows the ports-and-adapters layering Phase 1 established, with the composition root
(`bootstrap()`) wiring concrete adapters into port interfaces.

### 5.1 New ports

- `PasswordHasherPort` — `hash(plain): Promise<string>`, `verify(plain, hash): Promise<boolean>`
- `TokenIssuerPort` — `issue(payload): Promise<string>`, `verify(token): Promise<Payload | null>`
- `CommunityRepositoryPort` — create, findById, findBySlug, listByCreator, update, slug-exists check
- `MembershipTierRepositoryPort` — create, listByCommunity, findById, update
- `ChannelRepositoryPort` — create, listByCommunity

Hashing and token issuance are ports, not direct calls, so every use-case test runs without
argon2's deliberate slowness or a real signing key.

### 5.2 New adapters

- `BunPasswordHasher` — wraps `Bun.password` (argon2id by default; no new dependency)
- `HonoJwtTokenIssuer` — wraps `hono/jwt` (built into Hono; no new dependency)
- `DrizzleCommunityRepository`, `DrizzleMembershipTierRepository`, `DrizzleChannelRepository`

### 5.3 Use-cases

`RegisterCreator`, `AuthenticateCreator`, `CreateCommunity`, `ListCommunitiesForCreator`,
`UpdateCommunity`, `DefineMembershipTier`, `ListTiers`, `UpdateTier`, `ConnectChannel`.

### 5.4 Domain

- `Creator` entity — email normalization (lowercase/trim) and invariants
- `Community` entity — including **slug generation**: `slugify(name)` plus a numeric
  collision suffix. This lives in the domain, not the repository, because what a shareable
  link looks like is a business rule and must be testable without a database.
- `MembershipTier` — already exists from Phase 1; reused as-is.

## 6. HTTP layer

**Public routes:**
- `POST /auth/signup` — name, email, password → creator + JWT
- `POST /auth/login` — email, password → JWT

**Authenticated routes (Bearer token):**
- `POST /communities`, `GET /communities`, `PATCH /communities/:id`
- `POST /communities/:id/tiers`, `GET /communities/:id/tiers`, `PATCH /communities/:id/tiers/:tierId`
- `POST /communities/:id/channels`, `GET /communities/:id/channels`

### 6.1 Authorization is a first-class requirement

Authentication proves who the caller is; **authorization** proves the resource is theirs.
Every community-scoped route must verify the community belongs to the authenticated
creator. A logged-in creator reading another creator's members or revenue is the obvious
failure mode of this phase, so:

- Every protected use-case takes `creatorId` and scopes its repository query on it
- Cross-creator access returns 404 (not 403 — avoids confirming the resource exists)
- The implementation plan must include **explicit cross-creator denial tests**, not only
  happy-path tests, for every protected route

### 6.2 Conventions established here (used by all later phases)

- **Zod validation middleware** using the schemas from `packages/shared`
- **`app.onError`** mapping domain errors to status codes, so failures are structured JSON
  rather than bare 500s (carry-forward item from Phase 1's review)
- **Narrow per-route dependency types** — routes take `Pick<Dependencies, ...>` rather than
  the whole graph (carry-forward item; cheapest to establish now with 3 route groups
  instead of 30)

## 7. Errors

Domain errors map to HTTP through `app.onError`:

| Condition | Status |
|---|---|
| Zod validation failure | 400 |
| Missing/invalid/expired token | 401 |
| Email already registered | 409 |
| Wrong credentials, or account with no password set | 401 (generic — no account enumeration) |
| Resource not found, or not owned by caller | 404 |

## 8. Testing

- **Use-case unit tests with fake ports** — now genuinely possible: Phase 1's final review
  fixed the composition root so a hand-written fake port is assignable without casts
- **Integration tests per route** against real Postgres
- **Explicit cross-creator authorization tests** for every protected route
- **Domain tests** for slug generation and collision handling, with no database

## 9. Security notes

- Password hashes never leave the repository layer; no endpoint returns `password_hash`
- Login failures are generic — no distinction between unknown email and wrong password
- JWT signing secret comes from `JWT_SECRET` in the environment, with no committed default.
  `bootstrap()` throws if it is unset, so the API refuses to start rather than signing
  tokens with a fallback value. `apps/api/.env.example` documents it as a placeholder to
  be replaced, matching how `DATABASE_URL` is already handled.
- Slug uniqueness is enforced by a database constraint, not only application logic
