# Phase 2: Creator Auth & Community Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator can register, log in, and set up a community — defining membership
tiers and connecting a WhatsApp/Telegram channel — through an authenticated, validated
HTTP API.

**Architecture:** Extends Phase 1's ports-and-adapters layering. New ports
(`PasswordHasherPort`, `TokenIssuerPort`, and three repositories) are wired through the
existing `bootstrap()` composition root. This phase also establishes the HTTP conventions
every later phase reuses: Zod validation middleware backed by `packages/shared`,
`app.onError` domain-error mapping, JWT auth middleware, and narrow per-route dependency
types.

**Tech Stack:** Bun, Hono, PostgreSQL 16, Drizzle ORM, Zod, `Bun.password` (argon2id,
built in), `hono/jwt` (built into Hono), `bun:test`.

## Global Constraints

From `docs/superpowers/specs/2026-08-07-phase2-auth-community-design.md` and the parent MVP
spec. Every task's work implicitly includes these:

- Ports-and-adapters (SOLID): use-cases depend only on port interfaces, never on concrete
  SDKs. **Standing exception (ruled 2026-08-07):** liveness/readiness health checks may use
  the raw DB client — do not flag as a violation.
- Database is PostgreSQL, accessed exclusively through Drizzle ORM. Schema changes are made
  by editing `schema.ts` and running `bun run db:generate` — **never hand-write migration
  SQL, and never edit an already-applied migration** (`0000_*`, `0001_*`, `0002_*`).
- **Authorization, not just authentication:** every community-scoped use-case takes
  `creatorId` and scopes its repository query on it. Cross-creator access returns **404**
  (not 403 — never confirm a resource exists to a non-owner). Every protected route needs
  an explicit cross-creator denial test, not only a happy-path test.
- Password hashes never leave the repository layer — no endpoint may return
  `password_hash`.
- Login failures are generic: never distinguish "unknown email" from "wrong password"
  (no account enumeration).
- `JWT_SECRET` comes from the environment with no committed default; `bootstrap()` throws
  if unset.
- Runtime and package manager is Bun; test runner is `bun test`; `bun run typecheck` must
  stay at exit 0.
- Tests use `resetDatabase()` from `apps/api/src/db/test-helpers.ts` in `beforeEach` —
  never ad hoc per-file deletes. When you add a table's first test, confirm the table is in
  that helper's delete list (all 12 already are).

## Verified API facts

These were probed against the installed versions on 2026-08-07 — use them as written:

- `Bun.password.hash(plain)` returns an argon2id hash (`$argon2id$v=...`);
  `Bun.password.verify(plain, hash)` returns a boolean. No dependency needed.
- `hono/jwt` exports `sign` and `verify`. **`verify(token, secret, alg)` requires the third
  `alg` argument** — omitting it throws `JwtAlgorithmRequired`. Use `"HS256"` for both
  `sign` and `verify`.
- `verify` **throws** rather than returning null. Observed error classes:
  `JwtTokenSignatureMismatched` (wrong secret), `JwtTokenExpired` (past `exp`),
  `JwtTokenInvalid` (malformed). The adapter must catch these and return `null`.
- `c.set("key", value)` on a plain `Context` compiles and runs — middleware does **not**
  need its own generic parameter. The `Hono<{ Variables: AuthVariables }>` generic on the
  route app is what makes `c.get("creatorId")` typed at the handler.
- Mounting `app.route("/communities/:communityId/tiers", tierRoutes(deps))` makes
  `c.req.param("communityId")` resolve inside the mounted sub-app. Verified end to end:
  the request returned 201 with the parent path's param populated, and `tsc --noEmit`
  exited 0 on the whole arrangement.

---

### Task 1: `packages/shared` with Zod schemas

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/auth.schema.ts`
- Create: `packages/shared/src/community.schema.ts`
- Test: `packages/shared/src/auth.schema.test.ts`
- Modify: `apps/api/package.json` (add the workspace dependency)

**Interfaces:**
- Consumes: nothing.
- Produces, all re-exported from `packages/shared/src/index.ts` under the package name
  `@diudara/shared`: `signupSchema`, `loginSchema`, `createCommunitySchema`,
  `updateCommunitySchema`, `createTierSchema`, `updateTierSchema`, `connectChannelSchema`,
  and the inferred types `SignupInput`, `LoginInput`, `CreateCommunityInput`,
  `UpdateCommunityInput`, `CreateTierInput`, `UpdateTierInput`, `ConnectChannelInput`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/auth.schema.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { signupSchema, loginSchema } from "./auth.schema";

describe("signupSchema", () => {
  it("accepts a valid signup and lowercases the email", () => {
    const parsed = signupSchema.parse({
      name: "Budi",
      email: "Budi@Example.COM",
      password: "supersecret123",
    });
    expect(parsed.email).toBe("budi@example.com");
    expect(parsed.name).toBe("Budi");
  });

  it("rejects a password shorter than 8 characters", () => {
    const result = signupSchema.safeParse({
      name: "Budi",
      email: "budi@example.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed email", () => {
    const result = signupSchema.safeParse({
      name: "Budi",
      email: "not-an-email",
      password: "supersecret123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty name", () => {
    const result = signupSchema.safeParse({
      name: "   ",
      email: "budi@example.com",
      password: "supersecret123",
    });
    expect(result.success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("accepts valid credentials and lowercases the email", () => {
    const parsed = loginSchema.parse({ email: "BUDI@example.com", password: "whatever1" });
    expect(parsed.email).toBe("budi@example.com");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/shared
bun test src/auth.schema.test.ts
```

Expected: FAIL — `./auth.schema` cannot be resolved (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `packages/shared/package.json`:

```json
{
  "name": "@diudara/shared",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

Create `packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

Create `packages/shared/src/auth.schema.ts`:

```ts
import { z } from "zod";

const email = z.string().trim().toLowerCase().email();
const password = z.string().min(8).max(200);

export const signupSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email,
  password,
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
```

Create `packages/shared/src/community.schema.ts`:

```ts
import { z } from "zod";

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric words separated by single hyphens");

export const createCommunitySchema = z.object({
  name: z.string().trim().min(1).max(255),
  niche: z.string().trim().max(128).optional(),
});

export const updateCommunitySchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    niche: z.string().trim().max(128).optional(),
    slug: slug.optional(),
    status: z.enum(["active", "paused", "archived"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

export const createTierSchema = z.object({
  name: z.string().trim().min(1).max(128),
  priceAmount: z.number().int().min(0),
  billingCycle: z.enum(["monthly", "quarterly", "yearly"]),
});

export const updateTierSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    priceAmount: z.number().int().min(0).optional(),
    billingCycle: z.enum(["monthly", "quarterly", "yearly"]).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

export const connectChannelSchema = z.object({
  platform: z.enum(["whatsapp", "telegram"]),
  externalGroupId: z.string().trim().min(1).max(255),
});

export type CreateCommunityInput = z.infer<typeof createCommunitySchema>;
export type UpdateCommunityInput = z.infer<typeof updateCommunitySchema>;
export type CreateTierInput = z.infer<typeof createTierSchema>;
export type UpdateTierInput = z.infer<typeof updateTierSchema>;
export type ConnectChannelInput = z.infer<typeof connectChannelSchema>;
```

Create `packages/shared/src/index.ts`:

```ts
export * from "./auth.schema";
export * from "./community.schema";
```

Add the workspace dependency to `apps/api/package.json` — inside the existing
`"dependencies"` object, add:

```json
"@diudara/shared": "workspace:*",
"zod": "^3.23.0"
```

Then from the repo root:

```bash
bun install
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/shared
bun test src/auth.schema.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Verify the API can import the shared package**

```bash
cd ../../apps/api
bun run -e 'import { signupSchema } from "@diudara/shared"; console.log(signupSchema.parse({name:"A",email:"A@B.CO",password:"12345678"}).email)'
```

Expected: prints `a@b.co`. If the import fails, the workspace wiring is wrong — fix it
before continuing, since every later task depends on it.

- [ ] **Step 6: Commit**

```bash
cd ../..
git add packages/shared apps/api/package.json bun.lock package.json
git commit -m "feat: add @diudara/shared with Zod request schemas"
```

---

### Task 2: Schema migration — password hash, nullable WA number, community slug

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Test: `apps/api/src/db/schema-phase2.test.ts`

**Interfaces:**
- Consumes: existing `creators`, `communities` tables from `apps/api/src/db/schema.ts`.
- Produces: `creators.passwordHash` (varchar, nullable), `creators.whatsappNumber` relaxed
  to nullable, `communities.slug` (varchar, NOT NULL, UNIQUE) — plus one generated
  migration under `apps/api/drizzle/`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/schema-phase2.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import { creators, communities } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

describe("phase 2 schema changes", () => {
  it("stores a creator with a password hash and no whatsapp number", async () => {
    const [creator] = await db
      .insert(creators)
      .values({ name: "Budi", email: "budi@example.com", passwordHash: "$argon2id$fake" })
      .returning();

    expect(creator.whatsappNumber).toBeNull();
    expect(creator.passwordHash).toBe("$argon2id$fake");
  });

  it("rejects two communities with the same slug", async () => {
    const [creator] = await db
      .insert(creators)
      .values({ name: "Budi", email: "budi@example.com" })
      .returning();

    await db
      .insert(communities)
      .values({ creatorId: creator.id, name: "Kelas Budi", slug: "kelas-budi" });

    let failed = false;
    try {
      await db
        .insert(communities)
        .values({ creatorId: creator.id, name: "Kelas Budi Lagi", slug: "kelas-budi" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    const rows = await db.select().from(communities);
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api
bun test src/db/schema-phase2.test.ts
```

Expected: FAIL — `passwordHash` and `slug` are not properties of the insert types (and the
columns do not exist in the database).

- [ ] **Step 3: Write the minimal implementation**

In `apps/api/src/db/schema.ts`, in the `creators` table definition, change the
`whatsappNumber` line and add `passwordHash` after `email`:

```ts
  whatsappNumber: varchar("whatsapp_number", { length: 32 }),
  email: varchar("email", { length: 255 }),
  passwordHash: varchar("password_hash", { length: 255 }),
```

In the `communities` table definition, add `slug` after `name`:

```ts
  slug: varchar("slug", { length: 120 }).notNull().unique(),
```

Generate and apply the migration:

```bash
bun run db:generate
bun run db:migrate
```

**If `db:generate` prompts** about the `whatsapp_number` nullability change or asks to
truncate data, read the prompt carefully. The table is empty in development, so accepting
is safe — but if it offers to drop and recreate a column that would lose data, stop and
report rather than accepting blindly.

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test src/db/schema-phase2.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite to confirm no regression**

```bash
bun test
```

Expected: all previously passing tests still pass. Phase 1's tests insert creators without
a password hash, which is still valid since the column is nullable.

- [ ] **Step 6: Commit**

```bash
cd ../..
git add apps/api/src/db/schema.ts apps/api/src/db/schema-phase2.test.ts apps/api/drizzle
git commit -m "feat(db): add creator password hash, nullable WA number, community slug"
```

---

### Task 3: Domain — Creator entity and slug generation

**Files:**
- Create: `apps/api/src/domain/creator.ts`
- Create: `apps/api/src/domain/slug.ts`
- Test: `apps/api/src/domain/creator.test.ts`
- Test: `apps/api/src/domain/slug.test.ts`

**Interfaces:**
- Consumes: nothing (pure domain, no framework or database imports).
- Produces:
  - `normalizeEmail(raw: string): string` from `apps/api/src/domain/creator.ts`
  - `slugify(name: string): string` and
    `resolveSlugCollision(base: string, taken: (s: string) => Promise<boolean>): Promise<string>`
    from `apps/api/src/domain/slug.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/domain/slug.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { slugify, resolveSlugCollision } from "./slug";

describe("slugify", () => {
  it("lowercases and hyphenates a normal name", () => {
    expect(slugify("Kelas Bimbel Budi")).toBe("kelas-bimbel-budi");
  });

  it("strips punctuation and collapses whitespace", () => {
    expect(slugify("  Kajian   Online: Fiqih & Hadits!  ")).toBe("kajian-online-fiqih-hadits");
  });

  it("removes leading and trailing hyphens", () => {
    expect(slugify("--Halo--")).toBe("halo");
  });

  it("falls back to 'komunitas' when nothing usable remains", () => {
    expect(slugify("!!!")).toBe("komunitas");
  });

  it("truncates very long names to 120 characters without a trailing hyphen", () => {
    const result = slugify("a".repeat(200));
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith("-")).toBe(false);
  });
});

describe("resolveSlugCollision", () => {
  it("returns the base slug when it is free", async () => {
    const result = await resolveSlugCollision("kelas-budi", async () => false);
    expect(result).toBe("kelas-budi");
  });

  it("appends -2 when the base is taken", async () => {
    const taken = new Set(["kelas-budi"]);
    const result = await resolveSlugCollision("kelas-budi", async (s) => taken.has(s));
    expect(result).toBe("kelas-budi-2");
  });

  it("keeps incrementing past consecutive collisions", async () => {
    const taken = new Set(["kelas-budi", "kelas-budi-2", "kelas-budi-3"]);
    const result = await resolveSlugCollision("kelas-budi", async (s) => taken.has(s));
    expect(result).toBe("kelas-budi-4");
  });
});
```

Create `apps/api/src/domain/creator.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { normalizeEmail } from "./creator";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Budi@Example.COM  ")).toBe("budi@example.com");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api
bun test src/domain/slug.test.ts src/domain/creator.test.ts
```

Expected: FAIL — `./slug` and `./creator` cannot be resolved.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/api/src/domain/slug.ts`:

```ts
const MAX_SLUG_LENGTH = 120;
const FALLBACK_SLUG = "komunitas";

export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (base.length === 0) {
    return FALLBACK_SLUG;
  }

  return base.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
}

/**
 * Finds a free slug by appending an incrementing suffix.
 * `taken` reports whether a candidate is already in use.
 */
export async function resolveSlugCollision(
  base: string,
  taken: (candidate: string) => Promise<boolean>
): Promise<string> {
  if (!(await taken(base))) {
    return base;
  }

  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!(await taken(candidate))) {
      return candidate;
    }
  }

  throw new Error(`could not find a free slug for "${base}" after 1000 attempts`);
}
```

Create `apps/api/src/domain/creator.ts`:

```ts
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test src/domain/slug.test.ts src/domain/creator.test.ts
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd ../..
git add apps/api/src/domain
git commit -m "feat(domain): add email normalization and community slug generation"
```

---

### Task 4: Auth ports and adapters (password hashing, JWT)

**Files:**
- Create: `apps/api/src/application/ports/password-hasher.port.ts`
- Create: `apps/api/src/application/ports/token-issuer.port.ts`
- Create: `apps/api/src/infrastructure/auth/bun-password.hasher.ts`
- Create: `apps/api/src/infrastructure/auth/hono-jwt.token-issuer.ts`
- Test: `apps/api/src/infrastructure/auth/bun-password.hasher.test.ts`
- Test: `apps/api/src/infrastructure/auth/hono-jwt.token-issuer.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `PasswordHasherPort` — `hash(plain: string): Promise<string>`,
    `verify(plain: string, hash: string): Promise<boolean>`
  - `TokenPayload` — `{ creatorId: string }`
  - `TokenIssuerPort` — `issue(payload: TokenPayload): Promise<string>`,
    `verify(token: string): Promise<TokenPayload | null>`
  - `BunPasswordHasher` (no constructor args) and
    `HonoJwtTokenIssuer` (constructor: `(secret: string, ttlSeconds?: number)`,
    default TTL 7 days)

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/application/ports/password-hasher.port.ts`:

```ts
export interface PasswordHasherPort {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}
```

Create `apps/api/src/application/ports/token-issuer.port.ts`:

```ts
export interface TokenPayload {
  creatorId: string;
}

export interface TokenIssuerPort {
  issue(payload: TokenPayload): Promise<string>;
  /** Returns null for any invalid token: bad signature, expired, or malformed. */
  verify(token: string): Promise<TokenPayload | null>;
}
```

Create `apps/api/src/infrastructure/auth/bun-password.hasher.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { BunPasswordHasher } from "./bun-password.hasher";

describe("BunPasswordHasher", () => {
  it("verifies a correct password against its hash", async () => {
    const hasher = new BunPasswordHasher();
    const hash = await hasher.hash("supersecret123");
    expect(await hasher.verify("supersecret123", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hasher = new BunPasswordHasher();
    const hash = await hasher.hash("supersecret123");
    expect(await hasher.verify("wrong-password", hash)).toBe(false);
  });

  it("does not store the plaintext in the hash", async () => {
    const hasher = new BunPasswordHasher();
    const hash = await hasher.hash("supersecret123");
    expect(hash).not.toContain("supersecret123");
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    const hasher = new BunPasswordHasher();
    expect(await hasher.verify("supersecret123", "not-a-real-hash")).toBe(false);
  });
});
```

Create `apps/api/src/infrastructure/auth/hono-jwt.token-issuer.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { HonoJwtTokenIssuer } from "./hono-jwt.token-issuer";

describe("HonoJwtTokenIssuer", () => {
  it("round-trips a payload", async () => {
    const issuer = new HonoJwtTokenIssuer("test-secret");
    const token = await issuer.issue({ creatorId: "creator-1" });
    const payload = await issuer.verify(token);
    expect(payload?.creatorId).toBe("creator-1");
  });

  it("returns null for a token signed with a different secret", async () => {
    const issuer = new HonoJwtTokenIssuer("test-secret");
    const other = new HonoJwtTokenIssuer("different-secret");
    const token = await other.issue({ creatorId: "creator-1" });
    expect(await issuer.verify(token)).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const issuer = new HonoJwtTokenIssuer("test-secret", -10);
    const token = await issuer.issue({ creatorId: "creator-1" });
    expect(await issuer.verify(token)).toBeNull();
  });

  it("returns null for a malformed token", async () => {
    const issuer = new HonoJwtTokenIssuer("test-secret");
    expect(await issuer.verify("not.a.jwt")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api
bun test src/infrastructure/auth
```

Expected: FAIL — neither adapter module exists yet.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/api/src/infrastructure/auth/bun-password.hasher.ts`:

```ts
import type { PasswordHasherPort } from "../../application/ports/password-hasher.port";

/** Uses Bun's built-in password hashing, which defaults to argon2id. */
export class BunPasswordHasher implements PasswordHasherPort {
  async hash(plain: string): Promise<string> {
    return Bun.password.hash(plain);
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    try {
      return await Bun.password.verify(plain, hash);
    } catch {
      // A malformed or unrecognised hash is a failed verification, not a crash.
      return false;
    }
  }
}
```

Create `apps/api/src/infrastructure/auth/hono-jwt.token-issuer.ts`:

```ts
import { sign, verify } from "hono/jwt";
import type {
  TokenIssuerPort,
  TokenPayload,
} from "../../application/ports/token-issuer.port";

const ALGORITHM = "HS256";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export class HonoJwtTokenIssuer implements TokenIssuerPort {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS
  ) {}

  async issue(payload: TokenPayload): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    return sign({ creatorId: payload.creatorId, exp }, this.secret, ALGORITHM);
  }

  async verify(token: string): Promise<TokenPayload | null> {
    try {
      // hono/jwt throws on bad signature, expiry, or malformed input —
      // and requires the algorithm to be passed explicitly.
      const decoded = await verify(token, this.secret, ALGORITHM);
      const creatorId = decoded.creatorId;
      if (typeof creatorId !== "string") {
        return null;
      }
      return { creatorId };
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test src/infrastructure/auth
```

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd ../..
git add apps/api/src/application/ports apps/api/src/infrastructure/auth
git commit -m "feat(auth): add password hasher and JWT token issuer ports with adapters"
```

---

### Task 5: Creator repository extensions and auth use-cases

**Files:**
- Modify: `apps/api/src/application/ports/creator-repository.port.ts`
- Modify: `apps/api/src/infrastructure/repositories/drizzle-creator.repository.ts`
- Create: `apps/api/src/application/use-cases/register-creator.ts`
- Create: `apps/api/src/application/use-cases/authenticate-creator.ts`
- Create: `apps/api/src/application/errors.ts`
- Test: `apps/api/src/application/use-cases/register-creator.test.ts`
- Test: `apps/api/src/application/use-cases/authenticate-creator.test.ts`

**Interfaces:**
- Consumes: `PasswordHasherPort`, `TokenIssuerPort` (Task 4), `normalizeEmail` (Task 3),
  `creators` table with `passwordHash` (Task 2).
- Produces:
  - `CreatorRecord` gains `passwordHash: string | null`; `create()` accepts an optional
    `passwordHash` and `whatsappNumber` is now optional.
  - `apps/api/src/application/errors.ts` exporting `AppError` (with a `status` field),
    `ConflictError` (409), `UnauthorizedError` (401), `NotFoundError` (404),
    `ValidationError` (400).
  - `RegisterCreator` class — `execute(input: { name, email, password }): Promise<{ creator, token }>`
  - `AuthenticateCreator` class — `execute(input: { email, password }): Promise<{ creator, token }>`
  - Both return `creator` as `{ id, name, email }` only — **never** the password hash.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/application/errors.ts` first (both tests import from it):

```ts
export class AppError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = "invalid request") {
    super(message, 400);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized") {
    super(message, 401);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "not found") {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = "already exists") {
    super(message, 409);
  }
}
```

Create `apps/api/src/application/use-cases/register-creator.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { RegisterCreator } from "./register-creator";
import { ConflictError } from "../errors";
import type { CreatorRecord, CreatorRepositoryPort } from "../ports/creator-repository.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { TokenIssuerPort, TokenPayload } from "../ports/token-issuer.port";

function fakeRepository(seed: CreatorRecord[] = []) {
  const rows = [...seed];
  const repository: CreatorRepositoryPort = {
    async create(input) {
      const row: CreatorRecord = {
        id: `creator-${rows.length + 1}`,
        name: input.name,
        whatsappNumber: input.whatsappNumber ?? null,
        email: input.email ?? null,
        passwordHash: input.passwordHash ?? null,
        tierPlan: "starter",
        createdAt: new Date(),
      };
      rows.push(row);
      return row;
    },
    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async findByEmail(email) {
      return rows.find((r) => r.email === email) ?? null;
    },
  };
  return { repository, rows };
}

const fakeHasher: PasswordHasherPort = {
  async hash(plain) {
    return `hashed:${plain}`;
  },
  async verify(plain, hash) {
    return hash === `hashed:${plain}`;
  },
};

const fakeIssuer: TokenIssuerPort = {
  async issue(payload) {
    return `token-for-${payload.creatorId}`;
  },
  async verify(token): Promise<TokenPayload | null> {
    const id = token.replace("token-for-", "");
    return id ? { creatorId: id } : null;
  },
};

describe("RegisterCreator", () => {
  it("creates a creator with a hashed password and returns a token", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = new RegisterCreator(repository, fakeHasher, fakeIssuer);

    const result = await useCase.execute({
      name: "Budi",
      email: "budi@example.com",
      password: "supersecret123",
    });

    expect(result.creator.email).toBe("budi@example.com");
    expect(result.token).toBe("token-for-creator-1");
    expect(rows[0].passwordHash).toBe("hashed:supersecret123");
  });

  it("never returns the password hash to the caller", async () => {
    const { repository } = fakeRepository();
    const useCase = new RegisterCreator(repository, fakeHasher, fakeIssuer);

    const result = await useCase.execute({
      name: "Budi",
      email: "budi@example.com",
      password: "supersecret123",
    });

    expect(JSON.stringify(result.creator)).not.toContain("hashed:");
    expect("passwordHash" in result.creator).toBe(false);
  });

  it("normalizes the email before storing it", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = new RegisterCreator(repository, fakeHasher, fakeIssuer);

    await useCase.execute({
      name: "Budi",
      email: "  BUDI@Example.COM ",
      password: "supersecret123",
    });

    expect(rows[0].email).toBe("budi@example.com");
  });

  it("rejects an email that is already registered", async () => {
    const { repository } = fakeRepository([
      {
        id: "existing",
        name: "Someone",
        whatsappNumber: null,
        email: "budi@example.com",
        passwordHash: "hashed:whatever",
        tierPlan: "starter",
        createdAt: new Date(),
      },
    ]);
    const useCase = new RegisterCreator(repository, fakeHasher, fakeIssuer);

    await expect(
      useCase.execute({ name: "Budi", email: "BUDI@example.com", password: "supersecret123" })
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
```

Create `apps/api/src/application/use-cases/authenticate-creator.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { AuthenticateCreator } from "./authenticate-creator";
import { UnauthorizedError } from "../errors";
import type { CreatorRecord, CreatorRepositoryPort } from "../ports/creator-repository.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { TokenIssuerPort, TokenPayload } from "../ports/token-issuer.port";

function creator(overrides: Partial<CreatorRecord> = {}): CreatorRecord {
  return {
    id: "creator-1",
    name: "Budi",
    whatsappNumber: null,
    email: "budi@example.com",
    passwordHash: "hashed:supersecret123",
    tierPlan: "starter",
    createdAt: new Date(),
    ...overrides,
  };
}

function fakeRepository(seed: CreatorRecord[]) {
  const repository: CreatorRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async findById(id) {
      return seed.find((r) => r.id === id) ?? null;
    },
    async findByEmail(email) {
      return seed.find((r) => r.email === email) ?? null;
    },
  };
  return repository;
}

const fakeHasher: PasswordHasherPort = {
  async hash(plain) {
    return `hashed:${plain}`;
  },
  async verify(plain, hash) {
    return hash === `hashed:${plain}`;
  },
};

const fakeIssuer: TokenIssuerPort = {
  async issue(payload) {
    return `token-for-${payload.creatorId}`;
  },
  async verify(token): Promise<TokenPayload | null> {
    const id = token.replace("token-for-", "");
    return id ? { creatorId: id } : null;
  },
};

describe("AuthenticateCreator", () => {
  it("returns a token for correct credentials", async () => {
    const useCase = new AuthenticateCreator(fakeRepository([creator()]), fakeHasher, fakeIssuer);

    const result = await useCase.execute({
      email: "budi@example.com",
      password: "supersecret123",
    });

    expect(result.token).toBe("token-for-creator-1");
    expect(result.creator.id).toBe("creator-1");
  });

  it("rejects a wrong password", async () => {
    const useCase = new AuthenticateCreator(fakeRepository([creator()]), fakeHasher, fakeIssuer);

    await expect(
      useCase.execute({ email: "budi@example.com", password: "wrong-password" })
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects an unknown email with the same error as a wrong password", async () => {
    const useCase = new AuthenticateCreator(fakeRepository([creator()]), fakeHasher, fakeIssuer);

    const unknown = await useCase
      .execute({ email: "nobody@example.com", password: "supersecret123" })
      .catch((e) => e);
    const wrongPassword = await useCase
      .execute({ email: "budi@example.com", password: "wrong-password" })
      .catch((e) => e);

    // No account enumeration: both paths must be indistinguishable to the caller.
    expect(unknown).toBeInstanceOf(UnauthorizedError);
    expect(unknown.message).toBe(wrongPassword.message);
    expect(unknown.status).toBe(wrongPassword.status);
  });

  it("rejects an account that has no password set", async () => {
    const useCase = new AuthenticateCreator(
      fakeRepository([creator({ passwordHash: null })]),
      fakeHasher,
      fakeIssuer
    );

    await expect(
      useCase.execute({ email: "budi@example.com", password: "supersecret123" })
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("never returns the password hash", async () => {
    const useCase = new AuthenticateCreator(fakeRepository([creator()]), fakeHasher, fakeIssuer);

    const result = await useCase.execute({
      email: "budi@example.com",
      password: "supersecret123",
    });

    expect("passwordHash" in result.creator).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api
bun test src/application/use-cases
```

Expected: FAIL — the use-case modules do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Replace the contents of `apps/api/src/application/ports/creator-repository.port.ts`:

```ts
export interface CreatorRecord {
  id: string;
  name: string;
  whatsappNumber: string | null;
  email: string | null;
  passwordHash: string | null;
  tierPlan: string;
  createdAt: Date;
}

export interface CreatorRepositoryPort {
  create(input: {
    name: string;
    whatsappNumber?: string;
    email?: string;
    passwordHash?: string;
  }): Promise<CreatorRecord>;
  findById(id: string): Promise<CreatorRecord | null>;
  findByEmail(email: string): Promise<CreatorRecord | null>;
}
```

In `apps/api/src/infrastructure/repositories/drizzle-creator.repository.ts`, update the
`create` method signature and body to carry the new fields:

```ts
  async create(input: {
    name: string;
    whatsappNumber?: string;
    email?: string;
    passwordHash?: string;
  }): Promise<CreatorRecord> {
    const [row] = await this.db
      .insert(creators)
      .values({
        name: input.name,
        whatsappNumber: input.whatsappNumber,
        email: input.email,
        passwordHash: input.passwordHash,
      })
      .returning();
    return row;
  }
```

Create `apps/api/src/application/use-cases/register-creator.ts`:

```ts
import { normalizeEmail } from "../../domain/creator";
import { ConflictError } from "../errors";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { TokenIssuerPort } from "../ports/token-issuer.port";

export interface PublicCreator {
  id: string;
  name: string;
  email: string | null;
}

export class RegisterCreator {
  constructor(
    private readonly creators: CreatorRepositoryPort,
    private readonly hasher: PasswordHasherPort,
    private readonly tokens: TokenIssuerPort
  ) {}

  async execute(input: { name: string; email: string; password: string }): Promise<{
    creator: PublicCreator;
    token: string;
  }> {
    const email = normalizeEmail(input.email);

    if (await this.creators.findByEmail(email)) {
      throw new ConflictError("email is already registered");
    }

    const passwordHash = await this.hasher.hash(input.password);
    const created = await this.creators.create({ name: input.name, email, passwordHash });
    const token = await this.tokens.issue({ creatorId: created.id });

    return {
      creator: { id: created.id, name: created.name, email: created.email },
      token,
    };
  }
}
```

Create `apps/api/src/application/use-cases/authenticate-creator.ts`:

```ts
import { normalizeEmail } from "../../domain/creator";
import { UnauthorizedError } from "../errors";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { TokenIssuerPort } from "../ports/token-issuer.port";
import type { PublicCreator } from "./register-creator";

/** Identical for unknown email, wrong password, and password-less accounts. */
const GENERIC_FAILURE = "invalid email or password";

export class AuthenticateCreator {
  constructor(
    private readonly creators: CreatorRepositoryPort,
    private readonly hasher: PasswordHasherPort,
    private readonly tokens: TokenIssuerPort
  ) {}

  async execute(input: { email: string; password: string }): Promise<{
    creator: PublicCreator;
    token: string;
  }> {
    const email = normalizeEmail(input.email);
    const found = await this.creators.findByEmail(email);

    if (!found || !found.passwordHash) {
      throw new UnauthorizedError(GENERIC_FAILURE);
    }

    if (!(await this.hasher.verify(input.password, found.passwordHash))) {
      throw new UnauthorizedError(GENERIC_FAILURE);
    }

    const token = await this.tokens.issue({ creatorId: found.id });

    return {
      creator: { id: found.id, name: found.name, email: found.email },
      token,
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test src/application/use-cases
```

Expected: PASS (9 tests).

- [ ] **Step 5: Run the full suite and typecheck**

```bash
bun test
bun run typecheck
```

Expected: all tests pass; typecheck exits 0. The existing
`drizzle-creator.repository.test.ts` still passes because `whatsappNumber` remains
accepted, now as an optional field.

- [ ] **Step 6: Commit**

```bash
cd ../..
git add apps/api/src/application apps/api/src/infrastructure/repositories
git commit -m "feat(auth): add register and authenticate creator use-cases"
```

---

### Task 6: HTTP conventions — error mapping, validation, auth middleware

**Files:**
- Create: `apps/api/src/http/error-handler.ts`
- Create: `apps/api/src/http/validate.ts`
- Create: `apps/api/src/http/auth.middleware.ts`
- Test: `apps/api/src/http/error-handler.test.ts`
- Test: `apps/api/src/http/auth.middleware.test.ts`

**Interfaces:**
- Consumes: `AppError` and subclasses (Task 5), `TokenIssuerPort` (Task 4).
- Produces:
  - `errorHandler(err: Error, c: Context): Response` — attach with `app.onError(errorHandler)`
  - `validate(schema)` — Hono middleware; on success stores the parsed value, retrievable
    with `c.get("validated")`; on failure throws `ValidationError` with the Zod issues
  - `requireAuth(tokens: TokenIssuerPort)` — Hono middleware; on success sets
    `c.set("creatorId", id)`; on failure throws `UnauthorizedError`
  - `AuthVariables` type — `{ creatorId: string; validated: unknown }`, used as the Hono
    generic so `c.get`/`c.set` are typed

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/http/error-handler.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { errorHandler } from "./error-handler";
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from "../application/errors";

function appThatThrows(err: Error) {
  const app = new Hono();
  app.onError(errorHandler);
  app.get("/boom", () => {
    throw err;
  });
  return app;
}

describe("errorHandler", () => {
  it("maps ValidationError to 400", async () => {
    const res = await appThatThrows(new ValidationError("bad input")).request("/boom");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad input" });
  });

  it("maps UnauthorizedError to 401", async () => {
    const res = await appThatThrows(new UnauthorizedError()).request("/boom");
    expect(res.status).toBe(401);
  });

  it("maps NotFoundError to 404", async () => {
    const res = await appThatThrows(new NotFoundError()).request("/boom");
    expect(res.status).toBe(404);
  });

  it("maps ConflictError to 409", async () => {
    const res = await appThatThrows(new ConflictError("email is already registered")).request("/boom");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "email is already registered" });
  });

  it("maps an unexpected error to 500 without leaking its message", async () => {
    const res = await appThatThrows(new Error("connection string user:password@host")).request("/boom");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal server error" });
    expect(JSON.stringify(body)).not.toContain("password@host");
  });
});
```

Create `apps/api/src/http/auth.middleware.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { errorHandler } from "./error-handler";
import { requireAuth, type AuthVariables } from "./auth.middleware";
import type { TokenIssuerPort, TokenPayload } from "../application/ports/token-issuer.port";

const fakeIssuer: TokenIssuerPort = {
  async issue(payload) {
    return `token-for-${payload.creatorId}`;
  },
  async verify(token): Promise<TokenPayload | null> {
    if (!token.startsWith("token-for-")) return null;
    return { creatorId: token.replace("token-for-", "") };
  },
};

function protectedApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(errorHandler);
  app.use("/me", requireAuth(fakeIssuer));
  app.get("/me", (c) => c.json({ creatorId: c.get("creatorId") }));
  return app;
}

describe("requireAuth", () => {
  it("allows a request with a valid Bearer token and exposes the creator id", async () => {
    const res = await protectedApp().request("/me", {
      headers: { Authorization: "Bearer token-for-creator-9" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ creatorId: "creator-9" });
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await protectedApp().request("/me");
    expect(res.status).toBe(401);
  });

  it("rejects a token that does not verify", async () => {
    const res = await protectedApp().request("/me", {
      headers: { Authorization: "Bearer garbage" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects an Authorization header that is not a Bearer scheme", async () => {
    const res = await protectedApp().request("/me", {
      headers: { Authorization: "Basic token-for-creator-9" },
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api
bun test src/http
```

Expected: FAIL — the `http` modules do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/api/src/http/error-handler.ts`:

```ts
import type { Context } from "hono";
import { AppError } from "../application/errors";

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    return c.json({ error: err.message }, err.status as 400);
  }

  // Never surface an unexpected error's message — it may contain connection
  // strings, secrets, or internal paths.
  console.error("unhandled error:", err);
  return c.json({ error: "internal server error" }, 500);
}
```

Create `apps/api/src/http/validate.ts`:

```ts
import type { Context, Next } from "hono";
import type { ZodSchema } from "zod";
import { ValidationError } from "../application/errors";

/**
 * Parses the JSON body against `schema`, storing the result under `validated`.
 * Retrieve it in the handler with `c.get("validated")`.
 */
export function validate(schema: ZodSchema) {
  return async (c: Context, next: Next) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ValidationError("request body must be valid JSON");
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      throw new ValidationError(detail);
    }

    c.set("validated", result.data);
    await next();
  };
}
```

Create `apps/api/src/http/auth.middleware.ts`:

```ts
import type { Context, Next } from "hono";
import { UnauthorizedError } from "../application/errors";
import type { TokenIssuerPort } from "../application/ports/token-issuer.port";

export interface AuthVariables {
  creatorId: string;
  validated: unknown;
}

const BEARER_PREFIX = "Bearer ";

export function requireAuth(tokens: TokenIssuerPort) {
  return async (c: Context, next: Next) => {
    const header = c.req.header("Authorization");
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedError("missing bearer token");
    }

    const payload = await tokens.verify(header.slice(BEARER_PREFIX.length));
    if (!payload) {
      throw new UnauthorizedError("invalid or expired token");
    }

    c.set("creatorId", payload.creatorId);
    await next();
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test src/http
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd ../..
git add apps/api/src/http
git commit -m "feat(http): add error handler, Zod validation, and auth middleware"
```

---

### Task 7: Auth routes wired end to end

**Files:**
- Create: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/bootstrap.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/.env.example`
- Test: `apps/api/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `RegisterCreator`, `AuthenticateCreator` (Task 5), `validate`, `errorHandler`
  (Task 6), `signupSchema`, `loginSchema` (Task 1), `BunPasswordHasher`,
  `HonoJwtTokenIssuer` (Task 4).
- Produces:
  - `Dependencies` gains `registerCreator: RegisterCreator`,
    `authenticateCreator: AuthenticateCreator`, `tokenIssuer: TokenIssuerPort`.
    **Keep the existing explicit-interface style from Phase 1 — do not revert to
    `ReturnType<typeof bootstrap>`.**
  - `bootstrap()` reads `JWT_SECRET` and **throws if it is unset**.
  - `authRoutes(deps: Pick<Dependencies, "registerCreator" | "authenticateCreator">)` —
    note the narrow `Pick` type; do not pass the whole `Dependencies` object.
  - `POST /auth/signup` → 201 `{ creator, token }`; `POST /auth/login` → 200 `{ creator, token }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/auth.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

async function signup(body: unknown) {
  return app().request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function login(body: unknown) {
  return app().request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID = { name: "Budi", email: "budi@example.com", password: "supersecret123" };

describe("POST /auth/signup", () => {
  it("creates a creator and returns a token", async () => {
    const res = await signup(VALID);
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.creator.email).toBe("budi@example.com");
    expect(typeof body.token).toBe("string");
    expect(body.token.split(".").length).toBe(3);
  });

  it("never includes the password hash in the response", async () => {
    const res = await signup(VALID);
    const text = await res.text();
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("argon2");
  });

  it("rejects a duplicate email with 409", async () => {
    await signup(VALID);
    const res = await signup({ ...VALID, name: "Someone Else" });
    expect(res.status).toBe(409);
  });

  it("rejects a short password with 400", async () => {
    const res = await signup({ ...VALID, password: "short" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await app().request("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/login", () => {
  it("returns a token for correct credentials", async () => {
    await signup(VALID);
    const res = await login({ email: VALID.email, password: VALID.password });
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).token).toBe("string");
  });

  it("accepts a differently-cased email", async () => {
    await signup(VALID);
    const res = await login({ email: "BUDI@Example.COM", password: VALID.password });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong password with 401", async () => {
    await signup(VALID);
    const res = await login({ email: VALID.email, password: "wrong-password" });
    expect(res.status).toBe(401);
  });

  it("returns an identical response for an unknown email and a wrong password", async () => {
    await signup(VALID);
    const unknown = await login({ email: "nobody@example.com", password: VALID.password });
    const wrong = await login({ email: VALID.email, password: "wrong-password" });

    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.text()).toBe(await wrong.text());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api
bun test src/routes/auth.test.ts
```

Expected: FAIL — `/auth/signup` is not routed (404), and `../routes/auth` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Add to `apps/api/.env.example` (below `DATABASE_URL`):

```
# Signing secret for creator session JWTs. Generate your own, e.g.:
#   openssl rand -base64 32
# The API refuses to start if this is unset.
JWT_SECRET=change_me_to_a_long_random_string
```

Then set it in your local `.env`:

```bash
echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env
```

Create `apps/api/src/routes/auth.ts`:

```ts
import { Hono } from "hono";
import { loginSchema, signupSchema, type LoginInput, type SignupInput } from "@diudara/shared";
import { validate } from "../http/validate";
import type { AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

export function authRoutes(
  deps: Pick<Dependencies, "registerCreator" | "authenticateCreator">
) {
  return new Hono<{ Variables: AuthVariables }>()
    .post("/signup", validate(signupSchema), async (c) => {
      const input = c.get("validated") as SignupInput;
      const result = await deps.registerCreator.execute(input);
      return c.json(result, 201);
    })
    .post("/login", validate(loginSchema), async (c) => {
      const input = c.get("validated") as LoginInput;
      const result = await deps.authenticateCreator.execute(input);
      return c.json(result, 200);
    });
}
```

Update `apps/api/src/bootstrap.ts` — add the imports, the `JWT_SECRET` guard, the new
`Dependencies` members, and the wiring. Keep the existing explicit-interface style:

```ts
import { db, sql } from "./db/client";
import { DrizzleCreatorRepository } from "./infrastructure/repositories/drizzle-creator.repository";
import { BunPasswordHasher } from "./infrastructure/auth/bun-password.hasher";
import { HonoJwtTokenIssuer } from "./infrastructure/auth/hono-jwt.token-issuer";
import { RegisterCreator } from "./application/use-cases/register-creator";
import { AuthenticateCreator } from "./application/use-cases/authenticate-creator";
import type { CreatorRepositoryPort } from "./application/ports/creator-repository.port";
import type { TokenIssuerPort } from "./application/ports/token-issuer.port";
```

Add to the `Dependencies` interface:

```ts
  creatorRepository: CreatorRepositoryPort;
  tokenIssuer: TokenIssuerPort;
  registerCreator: RegisterCreator;
  authenticateCreator: AuthenticateCreator;
  sql: DatabasePing;
```

And in the `bootstrap()` body, before the return:

```ts
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error(
      "JWT_SECRET is not set. Add it to apps/api/.env — see .env.example. " +
        "Refusing to start rather than signing tokens with a default secret."
    );
  }

  const creatorRepository = new DrizzleCreatorRepository(db);
  const passwordHasher = new BunPasswordHasher();
  const tokenIssuer = new HonoJwtTokenIssuer(jwtSecret);
  const registerCreator = new RegisterCreator(creatorRepository, passwordHasher, tokenIssuer);
  const authenticateCreator = new AuthenticateCreator(
    creatorRepository,
    passwordHasher,
    tokenIssuer
  );
```

Returning `{ creatorRepository, tokenIssuer, registerCreator, authenticateCreator, sql }`.

Update `apps/api/src/app.ts` to mount the routes and the error handler:

```ts
import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { errorHandler } from "./http/error-handler";
import type { AuthVariables } from "./http/auth.middleware";
import type { Dependencies } from "./bootstrap";

export function createApp(deps: Dependencies) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(errorHandler);
  app.route("/health", healthRoute(deps));
  app.route("/auth", authRoutes(deps));
  return app;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test src/routes/auth.test.ts
```

Expected: PASS (9 tests).

- [ ] **Step 5: Verify the JWT_SECRET guard actually fires**

```bash
env -u JWT_SECRET bun -e 'import("./src/bootstrap").then(m => { try { m.bootstrap(); console.log("NO THROW (!)"); } catch (e) { console.log("THREW:", e.message.slice(0, 40)); } })'
```

Expected: prints `THREW: JWT_SECRET is not set...`. If it prints `NO THROW`, the guard is
not working — fix before committing. Record the output in your report.

- [ ] **Step 6: Run the full suite and typecheck**

```bash
bun test
bun run typecheck
```

Expected: all pass, typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
cd ../..
git add apps/api/src/routes/auth.ts apps/api/src/routes/auth.test.ts \
  apps/api/src/bootstrap.ts apps/api/src/app.ts apps/api/.env.example
git commit -m "feat(auth): add signup and login routes"
```

---

### Task 8: Community repository and use-cases

**Files:**
- Create: `apps/api/src/application/ports/community-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-community.repository.ts`
- Create: `apps/api/src/application/use-cases/create-community.ts`
- Create: `apps/api/src/application/use-cases/list-communities.ts`
- Create: `apps/api/src/application/use-cases/update-community.ts`
- Test: `apps/api/src/infrastructure/repositories/drizzle-community.repository.test.ts`
- Test: `apps/api/src/application/use-cases/create-community.test.ts`
- Test: `apps/api/src/application/use-cases/update-community.test.ts`

**Interfaces:**
- Consumes: `slugify`, `resolveSlugCollision` (Task 3), `NotFoundError` (Task 5),
  `communities` table with `slug` (Task 2).
- Produces:
  - `CommunityRecord` — `{ id, creatorId, name, slug, niche, status, createdAt }`
  - `CommunityRepositoryPort` — `create`, `findByIdForCreator(id, creatorId)`,
    `listByCreator(creatorId)`, `slugExists(slug)`,
    `update(id, creatorId, patch)`
  - `CreateCommunity`, `ListCommunities`, `UpdateCommunity` use-case classes
- **Authorization note:** `findByIdForCreator` and `update` take `creatorId` and scope the
  query on it. There is deliberately **no** unscoped `findById` on this port — that is what
  keeps a later caller from accidentally reading another creator's community.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/infrastructure/repositories/drizzle-community.repository.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { creators } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleCommunityRepository } from "./drizzle-community.repository";

beforeEach(resetDatabase);

async function makeCreator(email: string) {
  const [row] = await db.insert(creators).values({ name: "C", email }).returning();
  return row;
}

describe("DrizzleCommunityRepository", () => {
  it("creates a community and lists it for its creator", async () => {
    const repository = new DrizzleCommunityRepository(db);
    const creator = await makeCreator("a@example.com");

    const created = await repository.create({
      creatorId: creator.id,
      name: "Kelas Budi",
      slug: "kelas-budi",
      niche: "bimbel",
    });

    const listed = await repository.listByCreator(creator.id);
    expect(listed.length).toBe(1);
    expect(listed[0].id).toBe(created.id);
    expect(listed[0].slug).toBe("kelas-budi");
  });

  it("does not return another creator's community", async () => {
    const repository = new DrizzleCommunityRepository(db);
    const owner = await makeCreator("owner@example.com");
    const stranger = await makeCreator("stranger@example.com");

    const created = await repository.create({
      creatorId: owner.id,
      name: "Kelas Budi",
      slug: "kelas-budi",
    });

    expect(await repository.findByIdForCreator(created.id, stranger.id)).toBeNull();
    expect(await repository.findByIdForCreator(created.id, owner.id)).not.toBeNull();
    expect(await repository.listByCreator(stranger.id)).toEqual([]);
  });

  it("reports whether a slug is taken", async () => {
    const repository = new DrizzleCommunityRepository(db);
    const creator = await makeCreator("a@example.com");
    await repository.create({ creatorId: creator.id, name: "Kelas", slug: "kelas-budi" });

    expect(await repository.slugExists("kelas-budi")).toBe(true);
    expect(await repository.slugExists("belum-ada")).toBe(false);
  });

  it("refuses to update another creator's community", async () => {
    const repository = new DrizzleCommunityRepository(db);
    const owner = await makeCreator("owner@example.com");
    const stranger = await makeCreator("stranger@example.com");
    const created = await repository.create({
      creatorId: owner.id,
      name: "Asli",
      slug: "asli",
    });

    const result = await repository.update(created.id, stranger.id, { name: "Dibajak" });
    expect(result).toBeNull();

    const stillThere = await repository.findByIdForCreator(created.id, owner.id);
    expect(stillThere?.name).toBe("Asli");
  });
});
```

Create `apps/api/src/application/use-cases/create-community.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { CreateCommunity } from "./create-community";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

function fakeRepository(existingSlugs: string[] = []) {
  const rows: CommunityRecord[] = [];
  const slugs = new Set(existingSlugs);

  const repository: CommunityRepositoryPort = {
    async create(input) {
      const row: CommunityRecord = {
        id: `community-${rows.length + 1}`,
        creatorId: input.creatorId,
        name: input.name,
        slug: input.slug,
        niche: input.niche ?? null,
        status: "active",
        createdAt: new Date(),
      };
      rows.push(row);
      slugs.add(row.slug);
      return row;
    },
    async findByIdForCreator(id, creatorId) {
      return rows.find((r) => r.id === id && r.creatorId === creatorId) ?? null;
    },
    async listByCreator(creatorId) {
      return rows.filter((r) => r.creatorId === creatorId);
    },
    async slugExists(slug) {
      return slugs.has(slug);
    },
    async update(id, creatorId, patch) {
      const row = rows.find((r) => r.id === id && r.creatorId === creatorId);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
  };

  return { repository, rows };
}

describe("CreateCommunity", () => {
  it("derives a slug from the name", async () => {
    const { repository } = fakeRepository();
    const useCase = new CreateCommunity(repository);

    const created = await useCase.execute({
      creatorId: "creator-1",
      name: "Kelas Bimbel Budi",
    });

    expect(created.slug).toBe("kelas-bimbel-budi");
  });

  it("appends a suffix when the derived slug is taken", async () => {
    const { repository } = fakeRepository(["kelas-bimbel-budi"]);
    const useCase = new CreateCommunity(repository);

    const created = await useCase.execute({
      creatorId: "creator-1",
      name: "Kelas Bimbel Budi",
    });

    expect(created.slug).toBe("kelas-bimbel-budi-2");
  });

  it("assigns the community to the calling creator", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = new CreateCommunity(repository);

    await useCase.execute({ creatorId: "creator-7", name: "Kelas" });

    expect(rows[0].creatorId).toBe("creator-7");
  });
});
```

Create `apps/api/src/application/use-cases/update-community.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { UpdateCommunity } from "./update-community";
import { ConflictError, NotFoundError } from "../errors";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

function fakeRepository(seed: CommunityRecord[] = []) {
  const rows = [...seed];
  const repository: CommunityRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async findByIdForCreator(id, creatorId) {
      return rows.find((r) => r.id === id && r.creatorId === creatorId) ?? null;
    },
    async listByCreator(creatorId) {
      return rows.filter((r) => r.creatorId === creatorId);
    },
    async slugExists(slug) {
      return rows.some((r) => r.slug === slug);
    },
    async update(id, creatorId, patch) {
      const row = rows.find((r) => r.id === id && r.creatorId === creatorId);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
  };
  return { repository, rows };
}

function community(overrides: Partial<CommunityRecord> = {}): CommunityRecord {
  return {
    id: "community-1",
    creatorId: "creator-1",
    name: "Kelas Budi",
    slug: "kelas-budi",
    niche: null,
    status: "active",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("UpdateCommunity", () => {
  it("updates a field the caller owns", async () => {
    const { repository } = fakeRepository([community()]);
    const useCase = new UpdateCommunity(repository);

    const updated = await useCase.execute({
      communityId: "community-1",
      creatorId: "creator-1",
      patch: { name: "Kelas Budi Premium" },
    });

    expect(updated.name).toBe("Kelas Budi Premium");
  });

  it("throws NotFoundError when the community belongs to another creator", async () => {
    const { repository } = fakeRepository([community()]);
    const useCase = new UpdateCommunity(repository);

    await expect(
      useCase.execute({
        communityId: "community-1",
        creatorId: "someone-else",
        patch: { name: "Dibajak" },
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a slug that another community already uses", async () => {
    const { repository } = fakeRepository([
      community(),
      community({ id: "community-2", slug: "sudah-dipakai" }),
    ]);
    const useCase = new UpdateCommunity(repository);

    await expect(
      useCase.execute({
        communityId: "community-1",
        creatorId: "creator-1",
        patch: { slug: "sudah-dipakai" },
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows re-saving a community's own current slug", async () => {
    const { repository } = fakeRepository([community()]);
    const useCase = new UpdateCommunity(repository);

    const updated = await useCase.execute({
      communityId: "community-1",
      creatorId: "creator-1",
      patch: { slug: "kelas-budi", name: "Nama Baru" },
    });

    expect(updated.slug).toBe("kelas-budi");
    expect(updated.name).toBe("Nama Baru");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api
bun test src/application/use-cases/create-community.test.ts \
  src/application/use-cases/update-community.test.ts \
  src/infrastructure/repositories/drizzle-community.repository.test.ts
```

Expected: FAIL — none of the modules exist yet.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/api/src/application/ports/community-repository.port.ts`:

```ts
export interface CommunityRecord {
  id: string;
  creatorId: string;
  name: string;
  slug: string;
  niche: string | null;
  status: string;
  createdAt: Date;
}

export interface CommunityPatch {
  name?: string;
  niche?: string;
  slug?: string;
  status?: string;
}

/**
 * Every lookup is scoped by creatorId on purpose — there is no unscoped
 * findById, so a caller cannot accidentally read another creator's community.
 */
export interface CommunityRepositoryPort {
  create(input: {
    creatorId: string;
    name: string;
    slug: string;
    niche?: string;
  }): Promise<CommunityRecord>;
  findByIdForCreator(id: string, creatorId: string): Promise<CommunityRecord | null>;
  listByCreator(creatorId: string): Promise<CommunityRecord[]>;
  slugExists(slug: string): Promise<boolean>;
  update(id: string, creatorId: string, patch: CommunityPatch): Promise<CommunityRecord | null>;
}
```

Create `apps/api/src/infrastructure/repositories/drizzle-community.repository.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { communities } from "../../db/schema";
import type {
  CommunityPatch,
  CommunityRecord,
  CommunityRepositoryPort,
} from "../../application/ports/community-repository.port";

export class DrizzleCommunityRepository implements CommunityRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

  async create(input: {
    creatorId: string;
    name: string;
    slug: string;
    niche?: string;
  }): Promise<CommunityRecord> {
    const [row] = await this.db
      .insert(communities)
      .values({
        creatorId: input.creatorId,
        name: input.name,
        slug: input.slug,
        niche: input.niche,
      })
      .returning();
    return row;
  }

  async findByIdForCreator(id: string, creatorId: string): Promise<CommunityRecord | null> {
    const [row] = await this.db
      .select()
      .from(communities)
      .where(and(eq(communities.id, id), eq(communities.creatorId, creatorId)))
      .limit(1);
    return row ?? null;
  }

  async listByCreator(creatorId: string): Promise<CommunityRecord[]> {
    return this.db.select().from(communities).where(eq(communities.creatorId, creatorId));
  }

  async slugExists(slug: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: communities.id })
      .from(communities)
      .where(eq(communities.slug, slug))
      .limit(1);
    return row !== undefined;
  }

  async update(
    id: string,
    creatorId: string,
    patch: CommunityPatch
  ): Promise<CommunityRecord | null> {
    const [row] = await this.db
      .update(communities)
      .set(patch)
      .where(and(eq(communities.id, id), eq(communities.creatorId, creatorId)))
      .returning();
    return row ?? null;
  }
}
```

Create `apps/api/src/application/use-cases/create-community.ts`:

```ts
import { resolveSlugCollision, slugify } from "../../domain/slug";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

export class CreateCommunity {
  constructor(private readonly communities: CommunityRepositoryPort) {}

  async execute(input: {
    creatorId: string;
    name: string;
    niche?: string;
  }): Promise<CommunityRecord> {
    const slug = await resolveSlugCollision(slugify(input.name), (candidate) =>
      this.communities.slugExists(candidate)
    );

    return this.communities.create({
      creatorId: input.creatorId,
      name: input.name,
      slug,
      niche: input.niche,
    });
  }
}
```

Create `apps/api/src/application/use-cases/list-communities.ts`:

```ts
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

export class ListCommunities {
  constructor(private readonly communities: CommunityRepositoryPort) {}

  async execute(creatorId: string): Promise<CommunityRecord[]> {
    return this.communities.listByCreator(creatorId);
  }
}
```

Create `apps/api/src/application/use-cases/update-community.ts`:

```ts
import { ConflictError, NotFoundError } from "../errors";
import type {
  CommunityPatch,
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

export class UpdateCommunity {
  constructor(private readonly communities: CommunityRepositoryPort) {}

  async execute(input: {
    communityId: string;
    creatorId: string;
    patch: CommunityPatch;
  }): Promise<CommunityRecord> {
    const existing = await this.communities.findByIdForCreator(
      input.communityId,
      input.creatorId
    );
    if (!existing) {
      throw new NotFoundError("community not found");
    }

    // Re-saving the community's own slug is fine; taking another's is not.
    if (input.patch.slug && input.patch.slug !== existing.slug) {
      if (await this.communities.slugExists(input.patch.slug)) {
        throw new ConflictError("slug is already taken");
      }
    }

    const updated = await this.communities.update(
      input.communityId,
      input.creatorId,
      input.patch
    );
    if (!updated) {
      throw new NotFoundError("community not found");
    }
    return updated;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test src/application/use-cases/create-community.test.ts \
  src/application/use-cases/update-community.test.ts \
  src/infrastructure/repositories/drizzle-community.repository.test.ts
```

Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
cd ../..
git add apps/api/src/application apps/api/src/infrastructure/repositories
git commit -m "feat(community): add community repository and CRUD use-cases"
```

---

### Task 9: Community routes with authorization tests

**Files:**
- Create: `apps/api/src/routes/communities.ts`
- Modify: `apps/api/src/bootstrap.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/communities.test.ts`
- Test: `apps/api/src/routes/test-support.ts`

**Interfaces:**
- Consumes: `CreateCommunity`, `ListCommunities`, `UpdateCommunity` (Task 8),
  `requireAuth` (Task 6), `createCommunitySchema`, `updateCommunitySchema` (Task 1).
- Produces:
  - `Dependencies` gains `createCommunity`, `listCommunities`, `updateCommunity`.
  - `communityRoutes(deps)` taking a narrow `Pick<Dependencies, ...>` including
    `tokenIssuer`.
  - `POST /communities` → 201, `GET /communities` → 200, `PATCH /communities/:id` → 200.
  - `apps/api/src/routes/test-support.ts` exporting
    `signupAndGetToken(app, overrides?)` — reused by Tasks 10 and 11.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/test-support.ts`:

```ts
import type { Hono } from "hono";

let counter = 0;

/** Signs up a fresh creator and returns their bearer token and id. */
export async function signupAndGetToken(
  app: Hono<any>,
  overrides: { name?: string; email?: string; password?: string } = {}
): Promise<{ token: string; creatorId: string; email: string }> {
  counter += 1;
  const email = overrides.email ?? `creator${counter}-${Date.now()}@example.com`;
  const res = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: overrides.name ?? `Creator ${counter}`,
      email,
      password: overrides.password ?? "supersecret123",
    }),
  });

  if (res.status !== 201) {
    throw new Error(`signup failed in test setup: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  return { token: body.token, creatorId: body.creator.id, email };
}

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
```

Create `apps/api/src/routes/communities.test.ts`:

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

describe("POST /communities", () => {
  it("creates a community with a slug derived from the name", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Bimbel Budi", niche: "bimbel" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slug).toBe("kelas-bimbel-budi");
    expect(body.name).toBe("Kelas Bimbel Budi");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app().request("/communities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Kelas" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an empty name with 400", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("gives the second community a suffixed slug", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Budi" }),
    });
    const res = await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Budi" }),
    });

    expect((await res.json()).slug).toBe("kelas-budi-2");
  });
});

describe("GET /communities", () => {
  it("returns only the calling creator's communities", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);

    await a.request("/communities", {
      method: "POST",
      headers: bearer(owner.token),
      body: JSON.stringify({ name: "Punya Owner" }),
    });

    const ownerList = await (
      await a.request("/communities", { headers: bearer(owner.token) })
    ).json();
    const strangerList = await (
      await a.request("/communities", { headers: bearer(stranger.token) })
    ).json();

    expect(ownerList.length).toBe(1);
    expect(ownerList[0].name).toBe("Punya Owner");
    expect(strangerList).toEqual([]);
  });
});

describe("PATCH /communities/:id", () => {
  it("updates a community the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const created = await (
      await a.request("/communities", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ name: "Nama Lama" }),
      })
    ).json();

    const res = await a.request(`/communities/${created.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ name: "Nama Baru" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Nama Baru");
  });

  it("returns 404 — not 403 — when updating another creator's community", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);

    const created = await (
      await a.request("/communities", {
        method: "POST",
        headers: bearer(owner.token),
        body: JSON.stringify({ name: "Asli" }),
      })
    ).json();

    const res = await a.request(`/communities/${created.id}`, {
      method: "PATCH",
      headers: bearer(stranger.token),
      body: JSON.stringify({ name: "Dibajak" }),
    });

    // 404, not 403: never confirm the resource exists to a non-owner.
    expect(res.status).toBe(404);

    const stillOriginal = await (
      await a.request("/communities", { headers: bearer(owner.token) })
    ).json();
    expect(stillOriginal[0].name).toBe("Asli");
  });

  it("rejects a slug already taken by another community with 409", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Sudah Dipakai" }),
    });
    const second = await (
      await a.request("/communities", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ name: "Yang Kedua" }),
      })
    ).json();

    const res = await a.request(`/communities/${second.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ slug: "sudah-dipakai" }),
    });

    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api
bun test src/routes/communities.test.ts
```

Expected: FAIL — `/communities` is not routed (404 on every case).

- [ ] **Step 3: Write the minimal implementation**

Create `apps/api/src/routes/communities.ts`:

```ts
import { Hono } from "hono";
import {
  createCommunitySchema,
  updateCommunitySchema,
  type CreateCommunityInput,
  type UpdateCommunityInput,
} from "@diudara/shared";
import { validate } from "../http/validate";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

export function communityRoutes(
  deps: Pick<
    Dependencies,
    "tokenIssuer" | "createCommunity" | "listCommunities" | "updateCommunity"
  >
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));

  app.post("/", validate(createCommunitySchema), async (c) => {
    const input = c.get("validated") as CreateCommunityInput;
    const created = await deps.createCommunity.execute({
      creatorId: c.get("creatorId"),
      ...input,
    });
    return c.json(created, 201);
  });

  app.get("/", async (c) => {
    return c.json(await deps.listCommunities.execute(c.get("creatorId")));
  });

  app.patch("/:id", validate(updateCommunitySchema), async (c) => {
    const patch = c.get("validated") as UpdateCommunityInput;
    const updated = await deps.updateCommunity.execute({
      communityId: c.req.param("id"),
      creatorId: c.get("creatorId"),
      patch,
    });
    return c.json(updated);
  });

  return app;
}
```

In `apps/api/src/bootstrap.ts`, add the imports, add
`createCommunity: CreateCommunity`, `listCommunities: ListCommunities`,
`updateCommunity: UpdateCommunity` to the `Dependencies` interface, and wire them:

```ts
  const communityRepository = new DrizzleCommunityRepository(db);
  const createCommunity = new CreateCommunity(communityRepository);
  const listCommunities = new ListCommunities(communityRepository);
  const updateCommunity = new UpdateCommunity(communityRepository);
```

adding all three to the returned object.

In `apps/api/src/app.ts`, mount the routes:

```ts
  app.route("/communities", communityRoutes(deps));
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test src/routes/communities.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 5: Run the full suite and typecheck**

```bash
bun test
bun run typecheck
```

Expected: all pass, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
cd ../..
git add apps/api/src/routes apps/api/src/bootstrap.ts apps/api/src/app.ts
git commit -m "feat(community): add authenticated community routes"
```

---

### Task 10: Membership tier repository, use-cases, and routes

**Files:**
- Create: `apps/api/src/application/ports/membership-tier-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-membership-tier.repository.ts`
- Create: `apps/api/src/application/use-cases/manage-tiers.ts`
- Create: `apps/api/src/routes/tiers.ts`
- Modify: `apps/api/src/bootstrap.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/tiers.test.ts`

**Interfaces:**
- Consumes: `CommunityRepositoryPort` (Task 8), `createMembershipTier` domain factory
  (Phase 1, `apps/api/src/domain/membership-tier.ts`), `createTierSchema`,
  `updateTierSchema` (Task 1), `signupAndGetToken`/`bearer` (Task 9).
- Produces:
  - `TierRecord` — `{ id, communityId, name, priceAmount, billingCycle, isActive }`
  - `MembershipTierRepositoryPort` — `create`, `listByCommunity`,
    `updateForCommunity(tierId, communityId, patch)`
  - `DefineMembershipTier`, `ListTiers`, `UpdateTier` use-case classes, all in
    `manage-tiers.ts` — they share the same ownership-check shape, so keeping them in one
    focused file avoids three near-identical files.
  - Routes nested under `/communities/:communityId/tiers`.
- **Authorization note:** each use-case first calls
  `communities.findByIdForCreator(communityId, creatorId)` and throws `NotFoundError` if
  absent — tier access is only ever granted through a community the caller owns.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/tiers.test.ts`:

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

async function makeCommunity(a: ReturnType<typeof app>, token: string, name = "Kelas Budi") {
  const res = await a.request("/communities", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ name }),
  });
  return res.json();
}

const TIER = { name: "Basic", priceAmount: 50000, billingCycle: "monthly" };

describe("POST /communities/:id/tiers", () => {
  it("creates a tier under a community the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(TIER),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Basic");
    expect(body.priceAmount).toBe(50000);
    expect(body.isActive).toBe(true);
  });

  it("returns 404 when creating a tier under another creator's community", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);

    const res = await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(stranger.token),
      body: JSON.stringify(TIER),
    });

    expect(res.status).toBe(404);
  });

  it("rejects a negative price with 400", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ ...TIER, priceAmount: -100 }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects an unknown billing cycle with 400", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ ...TIER, billingCycle: "weekly" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TIER),
    });

    expect(res.status).toBe(401);
  });
});

describe("GET /communities/:id/tiers", () => {
  it("lists tiers for a community the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(TIER),
    });

    const res = await a.request(`/communities/${community.id}/tiers`, {
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).length).toBe(1);
  });

  it("returns 404 when listing another creator's tiers", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);

    const res = await a.request(`/communities/${community.id}/tiers`, {
      headers: bearer(stranger.token),
    });

    expect(res.status).toBe(404);
  });
});

describe("PATCH /communities/:id/tiers/:tierId", () => {
  it("updates a tier the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    const tier = await (
      await a.request(`/communities/${community.id}/tiers`, {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify(TIER),
      })
    ).json();

    const res = await a.request(`/communities/${community.id}/tiers/${tier.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ priceAmount: 75000, isActive: false }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceAmount).toBe(75000);
    expect(body.isActive).toBe(false);
  });

  it("returns 404 when updating another creator's tier", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);
    const tier = await (
      await a.request(`/communities/${community.id}/tiers`, {
        method: "POST",
        headers: bearer(owner.token),
        body: JSON.stringify(TIER),
      })
    ).json();

    const res = await a.request(`/communities/${community.id}/tiers/${tier.id}`, {
      method: "PATCH",
      headers: bearer(stranger.token),
      body: JSON.stringify({ priceAmount: 1 }),
    });

    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api
bun test src/routes/tiers.test.ts
```

Expected: FAIL — the tier routes are not mounted.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/api/src/application/ports/membership-tier-repository.port.ts`:

```ts
export interface TierRecord {
  id: string;
  communityId: string;
  name: string;
  priceAmount: number;
  billingCycle: string;
  isActive: boolean;
}

export interface TierPatch {
  name?: string;
  priceAmount?: number;
  billingCycle?: string;
  isActive?: boolean;
}

export interface MembershipTierRepositoryPort {
  create(input: {
    communityId: string;
    name: string;
    priceAmount: number;
    billingCycle: string;
  }): Promise<TierRecord>;
  listByCommunity(communityId: string): Promise<TierRecord[]>;
  updateForCommunity(
    tierId: string,
    communityId: string,
    patch: TierPatch
  ): Promise<TierRecord | null>;
}
```

Create `apps/api/src/infrastructure/repositories/drizzle-membership-tier.repository.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { membershipTiers } from "../../db/schema";
import type {
  MembershipTierRepositoryPort,
  TierPatch,
  TierRecord,
} from "../../application/ports/membership-tier-repository.port";

export class DrizzleMembershipTierRepository implements MembershipTierRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

  async create(input: {
    communityId: string;
    name: string;
    priceAmount: number;
    billingCycle: string;
  }): Promise<TierRecord> {
    const [row] = await this.db.insert(membershipTiers).values(input).returning();
    return row;
  }

  async listByCommunity(communityId: string): Promise<TierRecord[]> {
    return this.db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.communityId, communityId));
  }

  async updateForCommunity(
    tierId: string,
    communityId: string,
    patch: TierPatch
  ): Promise<TierRecord | null> {
    const [row] = await this.db
      .update(membershipTiers)
      .set(patch)
      .where(and(eq(membershipTiers.id, tierId), eq(membershipTiers.communityId, communityId)))
      .returning();
    return row ?? null;
  }
}
```

Create `apps/api/src/application/use-cases/manage-tiers.ts`:

```ts
import { createMembershipTier, type BillingCycle } from "../../domain/membership-tier";
import { NotFoundError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type {
  MembershipTierRepositoryPort,
  TierPatch,
  TierRecord,
} from "../ports/membership-tier-repository.port";

/** Throws unless `creatorId` owns `communityId`. */
async function assertOwnsCommunity(
  communities: CommunityRepositoryPort,
  communityId: string,
  creatorId: string
): Promise<void> {
  const community = await communities.findByIdForCreator(communityId, creatorId);
  if (!community) {
    throw new NotFoundError("community not found");
  }
}

export class DefineMembershipTier {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort
  ) {}

  async execute(input: {
    communityId: string;
    creatorId: string;
    name: string;
    priceAmount: number;
    billingCycle: BillingCycle;
  }): Promise<TierRecord> {
    await assertOwnsCommunity(this.communities, input.communityId, input.creatorId);

    // Domain factory enforces the invariants (non-negative price, known cycle,
    // non-empty name) before anything reaches the database.
    createMembershipTier({
      id: "pending",
      communityId: input.communityId,
      name: input.name,
      priceAmount: input.priceAmount,
      billingCycle: input.billingCycle,
    });

    return this.tiers.create({
      communityId: input.communityId,
      name: input.name,
      priceAmount: input.priceAmount,
      billingCycle: input.billingCycle,
    });
  }
}

export class ListTiers {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort
  ) {}

  async execute(input: { communityId: string; creatorId: string }): Promise<TierRecord[]> {
    await assertOwnsCommunity(this.communities, input.communityId, input.creatorId);
    return this.tiers.listByCommunity(input.communityId);
  }
}

export class UpdateTier {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort
  ) {}

  async execute(input: {
    communityId: string;
    creatorId: string;
    tierId: string;
    patch: TierPatch;
  }): Promise<TierRecord> {
    await assertOwnsCommunity(this.communities, input.communityId, input.creatorId);

    const updated = await this.tiers.updateForCommunity(
      input.tierId,
      input.communityId,
      input.patch
    );
    if (!updated) {
      throw new NotFoundError("tier not found");
    }
    return updated;
  }
}
```

Create `apps/api/src/routes/tiers.ts`:

```ts
import { Hono } from "hono";
import {
  createTierSchema,
  updateTierSchema,
  type CreateTierInput,
  type UpdateTierInput,
} from "@diudara/shared";
import { validate } from "../http/validate";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

export function tierRoutes(
  deps: Pick<Dependencies, "tokenIssuer" | "defineTier" | "listTiers" | "updateTier">
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));

  app.post("/", validate(createTierSchema), async (c) => {
    const input = c.get("validated") as CreateTierInput;
    const created = await deps.defineTier.execute({
      communityId: c.req.param("communityId")!,
      creatorId: c.get("creatorId"),
      ...input,
    });
    return c.json(created, 201);
  });

  app.get("/", async (c) => {
    const tiers = await deps.listTiers.execute({
      communityId: c.req.param("communityId")!,
      creatorId: c.get("creatorId"),
    });
    return c.json(tiers);
  });

  app.patch("/:tierId", validate(updateTierSchema), async (c) => {
    const patch = c.get("validated") as UpdateTierInput;
    const updated = await deps.updateTier.execute({
      communityId: c.req.param("communityId")!,
      creatorId: c.get("creatorId"),
      tierId: c.req.param("tierId")!,
      patch,
    });
    return c.json(updated);
  });

  return app;
}
```

In `apps/api/src/bootstrap.ts`, add these imports:

```ts
import { DrizzleMembershipTierRepository } from "./infrastructure/repositories/drizzle-membership-tier.repository";
import {
  DefineMembershipTier,
  ListTiers,
  UpdateTier,
} from "./application/use-cases/manage-tiers";
```

Add to the `Dependencies` interface:

```ts
  defineTier: DefineMembershipTier;
  listTiers: ListTiers;
  updateTier: UpdateTier;
```

And in the `bootstrap()` body, after the community wiring from Task 9 (reusing the
`communityRepository` already constructed there — do not construct a second one):

```ts
  const tierRepository = new DrizzleMembershipTierRepository(db);
  const defineTier = new DefineMembershipTier(communityRepository, tierRepository);
  const listTiers = new ListTiers(communityRepository, tierRepository);
  const updateTier = new UpdateTier(communityRepository, tierRepository);
```

Add `defineTier`, `listTiers`, and `updateTier` to the returned object.

In `apps/api/src/app.ts`, mount the nested routes **before** the `/communities` route so
the more specific path matches first:

```ts
  app.route("/communities/:communityId/tiers", tierRoutes(deps));
  app.route("/communities", communityRoutes(deps));
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test src/routes/tiers.test.ts
```

Expected: PASS (9 tests). If `c.req.param("communityId")` is `undefined`, the nested mount
path is wrong — check the `app.route` order and path above before changing anything else.

- [ ] **Step 5: Run the full suite and typecheck**

```bash
bun test
bun run typecheck
```

Expected: all pass, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
cd ../..
git add apps/api/src
git commit -m "feat(tiers): add membership tier repository, use-cases, and routes"
```

---

### Task 11: Channel repository, use-cases, and routes

**Files:**
- Create: `apps/api/src/application/ports/channel-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-channel.repository.ts`
- Create: `apps/api/src/application/use-cases/manage-channels.ts`
- Create: `apps/api/src/routes/channels.ts`
- Modify: `apps/api/src/bootstrap.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/channels.test.ts`

**Interfaces:**
- Consumes: `CommunityRepositoryPort` (Task 8), `connectChannelSchema` (Task 1),
  `signupAndGetToken`/`bearer` (Task 9).
- Produces:
  - `ChannelRecord` — `{ id, communityId, platform, externalGroupId, inviteLink, botStatus }`
  - `ChannelRepositoryPort` — `create`, `listByCommunity`
  - `ConnectChannel`, `ListChannels` use-cases in `manage-channels.ts`
  - Routes nested under `/communities/:communityId/channels`
- **Scope note:** this task only records the channel in the database. It makes **no** call
  to WhatsApp or Telegram — `botStatus` stays at its `disconnected` default and
  `inviteLink` stays null until Phase 4 wires the real bot APIs.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/channels.test.ts`:

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

async function makeCommunity(a: ReturnType<typeof app>, token: string) {
  const res = await a.request("/communities", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ name: "Kelas Budi" }),
  });
  return res.json();
}

const CHANNEL = { platform: "telegram", externalGroupId: "-1001234567890" };

describe("POST /communities/:id/channels", () => {
  it("connects a channel to a community the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/channels`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(CHANNEL),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.platform).toBe("telegram");
    expect(body.externalGroupId).toBe("-1001234567890");
    // Phase 4 wires the real bot; until then the channel is recorded but not live.
    expect(body.botStatus).toBe("disconnected");
    expect(body.inviteLink).toBeNull();
  });

  it("returns 404 when connecting to another creator's community", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);

    const res = await a.request(`/communities/${community.id}/channels`, {
      method: "POST",
      headers: bearer(stranger.token),
      body: JSON.stringify(CHANNEL),
    });

    expect(res.status).toBe(404);
  });

  it("rejects an unsupported platform with 400", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/channels`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ platform: "discord", externalGroupId: "123" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CHANNEL),
    });

    expect(res.status).toBe(401);
  });
});

describe("GET /communities/:id/channels", () => {
  it("lists channels for a community the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    await a.request(`/communities/${community.id}/channels`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(CHANNEL),
    });

    const res = await a.request(`/communities/${community.id}/channels`, {
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).length).toBe(1);
  });

  it("returns 404 when listing another creator's channels", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);

    const res = await a.request(`/communities/${community.id}/channels`, {
      headers: bearer(stranger.token),
    });

    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api
bun test src/routes/channels.test.ts
```

Expected: FAIL — the channel routes are not mounted.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/api/src/application/ports/channel-repository.port.ts`:

```ts
export interface ChannelRecord {
  id: string;
  communityId: string;
  platform: string;
  externalGroupId: string | null;
  inviteLink: string | null;
  botStatus: string;
}

export interface ChannelRepositoryPort {
  create(input: {
    communityId: string;
    platform: string;
    externalGroupId: string;
  }): Promise<ChannelRecord>;
  listByCommunity(communityId: string): Promise<ChannelRecord[]>;
}
```

Create `apps/api/src/infrastructure/repositories/drizzle-channel.repository.ts`:

```ts
import { eq } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { channels } from "../../db/schema";
import type {
  ChannelRecord,
  ChannelRepositoryPort,
} from "../../application/ports/channel-repository.port";

export class DrizzleChannelRepository implements ChannelRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

  async create(input: {
    communityId: string;
    platform: string;
    externalGroupId: string;
  }): Promise<ChannelRecord> {
    const [row] = await this.db.insert(channels).values(input).returning();
    return row;
  }

  async listByCommunity(communityId: string): Promise<ChannelRecord[]> {
    return this.db.select().from(channels).where(eq(channels.communityId, communityId));
  }
}
```

Create `apps/api/src/application/use-cases/manage-channels.ts`:

```ts
import { NotFoundError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type {
  ChannelRecord,
  ChannelRepositoryPort,
} from "../ports/channel-repository.port";

async function assertOwnsCommunity(
  communities: CommunityRepositoryPort,
  communityId: string,
  creatorId: string
): Promise<void> {
  const community = await communities.findByIdForCreator(communityId, creatorId);
  if (!community) {
    throw new NotFoundError("community not found");
  }
}

export class ConnectChannel {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly channels: ChannelRepositoryPort
  ) {}

  /**
   * Records the channel only. Bot connection and invite-link generation
   * arrive in Phase 4 — botStatus stays "disconnected" until then.
   */
  async execute(input: {
    communityId: string;
    creatorId: string;
    platform: string;
    externalGroupId: string;
  }): Promise<ChannelRecord> {
    await assertOwnsCommunity(this.communities, input.communityId, input.creatorId);
    return this.channels.create({
      communityId: input.communityId,
      platform: input.platform,
      externalGroupId: input.externalGroupId,
    });
  }
}

export class ListChannels {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly channels: ChannelRepositoryPort
  ) {}

  async execute(input: {
    communityId: string;
    creatorId: string;
  }): Promise<ChannelRecord[]> {
    await assertOwnsCommunity(this.communities, input.communityId, input.creatorId);
    return this.channels.listByCommunity(input.communityId);
  }
}
```

Create `apps/api/src/routes/channels.ts`:

```ts
import { Hono } from "hono";
import { connectChannelSchema, type ConnectChannelInput } from "@diudara/shared";
import { validate } from "../http/validate";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

export function channelRoutes(
  deps: Pick<Dependencies, "tokenIssuer" | "connectChannel" | "listChannels">
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));

  app.post("/", validate(connectChannelSchema), async (c) => {
    const input = c.get("validated") as ConnectChannelInput;
    const created = await deps.connectChannel.execute({
      communityId: c.req.param("communityId")!,
      creatorId: c.get("creatorId"),
      ...input,
    });
    return c.json(created, 201);
  });

  app.get("/", async (c) => {
    const list = await deps.listChannels.execute({
      communityId: c.req.param("communityId")!,
      creatorId: c.get("creatorId"),
    });
    return c.json(list);
  });

  return app;
}
```

In `apps/api/src/bootstrap.ts`, add these imports:

```ts
import { DrizzleChannelRepository } from "./infrastructure/repositories/drizzle-channel.repository";
import { ConnectChannel, ListChannels } from "./application/use-cases/manage-channels";
```

Add to the `Dependencies` interface:

```ts
  connectChannel: ConnectChannel;
  listChannels: ListChannels;
```

And in the `bootstrap()` body, reusing the same `communityRepository`:

```ts
  const channelRepository = new DrizzleChannelRepository(db);
  const connectChannel = new ConnectChannel(communityRepository, channelRepository);
  const listChannels = new ListChannels(communityRepository, channelRepository);
```

Add `connectChannel` and `listChannels` to the returned object.

In `apps/api/src/app.ts`, mount alongside the tier routes, before `/communities`:

```ts
  app.route("/communities/:communityId/tiers", tierRoutes(deps));
  app.route("/communities/:communityId/channels", channelRoutes(deps));
  app.route("/communities", communityRoutes(deps));
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test src/routes/channels.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Run the full suite and typecheck — the phase completion gate**

```bash
bun test
bun run typecheck
cd ../.. && bun test
```

Expected: everything passes from both `apps/api` and the repo root; typecheck exits 0.

- [ ] **Step 6: Manually smoke-test the whole flow**

With Postgres running and `JWT_SECRET` set in `apps/api/.env`, start the server
(`cd apps/api && bun run dev`) and in another terminal:

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"name":"Budi","email":"budi@example.com","password":"supersecret123"}' \
  | grep -o '"token":"[^"]*' | cut -d'"' -f4)

COMMUNITY=$(curl -s -X POST localhost:3000/communities \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Kelas Bimbel Budi","niche":"bimbel"}')
echo "$COMMUNITY"

ID=$(echo "$COMMUNITY" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)

curl -s -X POST "localhost:3000/communities/$ID/tiers" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Basic","priceAmount":50000,"billingCycle":"monthly"}'

curl -s "localhost:3000/communities" -H "Authorization: Bearer $TOKEN"
```

Expected: signup returns a token; the community comes back with
`"slug":"kelas-bimbel-budi"`; the tier is created; the list shows one community. Record the
actual output in your report. Stop the dev server when done.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src
git commit -m "feat(channels): add channel repository, use-cases, and routes"
```
