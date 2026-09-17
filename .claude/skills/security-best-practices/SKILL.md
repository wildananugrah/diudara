---
name: security-best-practices
description: Comprehensive security hardening for web applications covering HTTPS, security headers, input validation, output encoding, authentication, authorization, CSRF, rate limiting, secret management, and the OWASP Top 10. Use this skill whenever the user is building, reviewing, or auditing a web application or API — especially when they mention authentication, login, JWT, sessions, cookies, CORS, CSP, Helmet, XSS, SQL injection, CSRF, OWASP, rate limiting, secrets, .env files, password hashing, access control, or when they ask to "secure", "harden", "audit", or "pentest" an app. Also trigger when the user is about to ship an endpoint that accepts user input, stores tokens, integrates a payment/banking API, or handles PII. Err on the side of triggering even if the user does not use the word "security" explicitly — any code path that touches auth, user input, file upload, third-party tokens, or production deployment benefits from this skill.
---

# Security Best Practices

A practical, stack-aware guide to hardening web applications. Apply the checklist in order of blast radius: transport → headers → input → auth → data → secrets → monitoring.

## How to use this skill

1. **If reviewing existing code**, walk the application layer-by-layer using the checklists below. For every issue found, quote the vulnerable line, state the risk (with CWE/OWASP category if relevant), and give a concrete fix with code.
2. **If building new features**, apply the relevant sections proactively. Do not wait for the user to ask "is this secure?" — raise concrete risks inline as you generate code.
3. **If the user asks about a specific topic** (e.g. "how do I do CSRF?"), go straight to that section but briefly mention adjacent concerns (CSRF defenses interact with CORS and cookie settings).
4. **For deeper OWASP Top 10 coverage**, read `references/owasp-top-10.md`.
5. **For authentication patterns** (JWT rotation, session cookies, password hashing), read `references/authentication.md`.

Always prefer battle-tested libraries over hand-rolled crypto/validation. Call out when the user's stack (Fastify, Express, Hono, Bun, Next.js, etc.) has a preferred primitive.

---

## 1. Transport security (HTTPS + HSTS)

Everything below is worthless if traffic can be intercepted. Enforce TLS at the edge and tell browsers to never downgrade.

- **Redirect HTTP → HTTPS** at the load balancer / reverse proxy (Nginx, Cloudflare, ALB). Never serve the app directly on port 80 in production.
- **Enable HSTS** with a long max-age once you are confident HTTPS works everywhere:
  ```
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  ```
- **Use TLS 1.2+** only. Disable TLS 1.0/1.1 and weak ciphers (RC4, 3DES). On Cloudflare, set Minimum TLS Version to 1.2.
- **Cookies**: always set `Secure`, `HttpOnly`, and `SameSite=Lax` (or `Strict` for high-value cookies). Never put session IDs or tokens in `localStorage` if you can avoid it — XSS will steal them.

---

## 2. Security headers (Helmet / manual)

Modern browsers enforce strong defenses *only if you ask*. In Express/Fastify use `helmet`; in Hono use `hono/secure-headers`; in Next.js configure `headers()` in `next.config.js`.

**Express / Fastify**
```js
import helmet from 'helmet';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],               // no 'unsafe-inline'
      styleSrc: ["'self'", "'unsafe-inline'"], // relax only if needed
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://api.yourdomain.com'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false, // flip on if you control all embedded content
}));
```

**Hono (Bun)**
```ts
import { secureHeaders } from 'hono/secure-headers';
app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    frameAncestors: ["'none'"],
  },
  strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
  xFrameOptions: 'DENY',
}));
```

**Headers to confirm in production** (check with `curl -I` or securityheaders.com):
- `Content-Security-Policy` — tightest realistic policy; avoid `'unsafe-inline'` and `'unsafe-eval'`
- `Strict-Transport-Security`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` (or CSP `frame-ancestors`)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` — disable camera/mic/geolocation unless used

---

## 3. Input validation (allow-list, not deny-list)

**Validate every untrusted input at the boundary.** Query strings, path params, headers, bodies, uploaded filenames, cookies — all untrusted. Use a schema validator (Zod, Joi, Valibot, class-validator) and reject unknown fields.

**Zod (preferred for TS projects)**
```ts
import { z } from 'zod';

const CreateUser = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(128),
  role: z.enum(['user', 'admin']).default('user'),
}).strict(); // reject extra fields

app.post('/users', async (c) => {
  const parsed = CreateUser.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  // parsed.data is now trusted and typed
});
```

**Joi (Express)**
```js
const schema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(12).required(),
}).options({ stripUnknown: true, abortEarly: false });
```

**Fastify** has first-class JSON Schema validation — use it via the `schema` option on every route.

**Rules of thumb**
- Allow-list, don't deny-list. List what is allowed; reject everything else.
- Enforce max length on every string. Missing limits lead to ReDoS, memory exhaustion, and logs full of garbage.
- Validate file uploads by magic bytes (not extension), enforce a size cap, and store outside the webroot (or in R2/S3 with a separate domain).
- Never pass user input into `eval`, `Function()`, `child_process.exec`, `fs.readFile(userPath)`, template strings evaluated at runtime, or shell commands. If you must spawn a process, use `execFile` with an argument array.

---

## 4. SQL injection prevention

**Never concatenate user input into SQL.** Use parameterized queries or an ORM that parameterizes by default.

**Prisma (safe by default)**
```ts
// ✅ safe — values are parameterized
await prisma.user.findFirst({ where: { email } });

// ⚠️ $queryRawUnsafe is a footgun — avoid
// ✅ use tagged template which parameterizes:
await prisma.$queryRaw`SELECT * FROM users WHERE email = ${email}`;
```

**pg / postgres.js**
```ts
await pool.query('SELECT * FROM users WHERE email = $1', [email]);
```

**Rules**
- No string concatenation into SQL — ever. Not for `ORDER BY`, not for table names, not for "just this one admin endpoint".
- Dynamic identifiers (column/table names) must come from a hardcoded allow-list, never directly from user input.
- Use a least-privileged DB user for the app. No `SUPERUSER`, no `CREATE`, no cross-schema access beyond what's needed. Banking-grade systems separate read/write roles.
- Use row-level security (RLS) in Postgres for multi-tenant data.

---

## 5. XSS and output encoding

XSS = attacker's HTML/JS ends up in another user's page. Defenses stack:

1. **Use a framework that escapes by default** (React, Vue, Svelte, Hono JSX). In React, `{userInput}` is safe; `dangerouslySetInnerHTML` is not.
2. **Sanitize rich HTML** only when you must render user-supplied markup (comments, rich text editors). Use `DOMPurify` with an allow-list:
   ```ts
   import DOMPurify from 'isomorphic-dompurify';
   const clean = DOMPurify.sanitize(userHtml, {
     ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'ul', 'ol', 'li'],
     ALLOWED_ATTR: ['href'],
   });
   ```
3. **Strict CSP** (section 2) makes reflected XSS much harder to exploit.
4. **Escape in the right context**. HTML body, HTML attribute, JS string, URL, and CSS each need different escaping. Let the framework handle it; don't hand-roll.
5. **`Content-Type`** on JSON responses: always `application/json; charset=utf-8` (never `text/html`).

---

## 6. Authentication

Password storage, session handling, and token rotation have specific correct answers. See `references/authentication.md` for full code. Key rules:

- **Password hashing**: `argon2id` (preferred) or `bcrypt` with cost ≥ 12. Never MD5, SHA-1, SHA-256, PBKDF2 with low iterations.
- **No passwords in logs**. Redact them before any logging middleware runs.
- **JWT**: sign with `HS256` (shared secret) or `RS256` (asymmetric). Short access token lifetime (5–15 min). Store the signing secret in env vars, never in code. Always verify `exp`, `iss`, `aud`.
- **Refresh tokens**: rotate on every use, store a hashed version server-side, and detect reuse (if an old refresh token is replayed, revoke the entire family — it means someone stole it).
- **Session cookies (often better than JWT)**: `HttpOnly; Secure; SameSite=Lax; Path=/`. Let the framework (Lucia, better-auth, NextAuth, express-session + Redis) handle the hard parts.
- **MFA**: support TOTP (RFC 6238) for any account that touches money or PII. For banking/financial apps, MFA is non-negotiable.
- **Rate-limit login, register, password reset, and MFA endpoints separately** (see section 9).
- **Generic error messages**. "Invalid email or password" — never "user not found" vs "wrong password" (enables user enumeration).

---

## 7. Authorization (access control)

OWASP #1 (Broken Access Control) is the most common real-world breach. It is *not* solved by authentication.

- **Check authorization on every request**, server-side, including for actions the UI "would never let the user take".
- **Object-level checks**: when the URL is `/api/orders/:id`, verify the current user owns order `:id`. IDOR (Insecure Direct Object Reference) is rampant.
- **Prefer opaque IDs** (UUIDs, ULIDs) over sequential integers — harder to enumerate.
- **Role checks at the middleware layer** plus resource ownership checks at the handler layer. Defense in depth.
- **Deny by default**. New endpoints should require auth unless explicitly marked public.
- **Admin endpoints**: separate router with its own middleware stack, separate logging, ideally a separate subdomain or network.

```ts
// Fastify example
async function requireOwner(req, reply) {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order || order.userId !== req.user.id) return reply.code(404).send(); // 404, not 403 — don't leak existence
  req.order = order;
}
app.get('/orders/:id', { preHandler: [requireAuth, requireOwner] }, getOrder);
```

---

## 8. CSRF protection

Only matters for state-changing requests authenticated by cookies. If you exclusively use `Authorization: Bearer` headers with cross-origin calls and no cookies, CSRF is largely moot — but you still need CORS correctly configured.

- **SameSite cookies**: `SameSite=Lax` blocks most CSRF. `Strict` is safer but breaks cross-site navigations.
- **CSRF tokens** for state-changing forms: double-submit cookie pattern or synchronizer token. `csrf-csrf` (Express/Fastify) or framework primitives (Next.js Server Actions, SvelteKit) handle this.
- **Require the custom header pattern**: if all state-changing requests include a non-simple header like `X-Requested-With: fetch`, CORS preflight protects you from cross-origin POSTs.
- **CORS**: allow-list origins explicitly. Never `Access-Control-Allow-Origin: *` together with `Access-Control-Allow-Credentials: true` (the browser will block it, but the intent is wrong).

---

## 9. Rate limiting and abuse protection

Rate limits protect against credential stuffing, scraping, enumeration, and accidental DDoS.

- **Global baseline**: e.g. 100 req/min per IP.
- **Stricter per-route limits** for auth, signup, password reset, OTP verification, forgot-password, payment endpoints. Aim for ≤ 5 attempts per 15 min per IP+email.
- **Storage**: in-process for a single instance; Redis for multi-instance. Libraries: `@fastify/rate-limit`, `express-rate-limit` + `rate-limit-redis`, `hono-rate-limiter`, or Cloudflare Rate Limiting at the edge.
- **Key by IP + identifier** (email, userId). IP-only limits are evaded by botnets.
- **Return `429 Too Many Requests`** with `Retry-After`.
- **Consider CAPTCHA / Turnstile** on signup and high-abuse endpoints. Prefer Cloudflare Turnstile over reCAPTCHA for privacy.
- **Log suspicious patterns** (many 401s from one IP, many 404s hitting sequential IDs) and alert.

---

## 10. Secret management

- **Never commit secrets.** Use `.env` locally, `.env.example` checked in, `.gitignore` excluding `.env*`. Run `git secrets` or `gitleaks` in CI.
- **Production secrets** live in a vault (AWS Secrets Manager, Doppler, 1Password, HashiCorp Vault) or the platform's env store (Vercel, Railway, Fly, Cloudflare Workers secrets). Never in Docker images.
- **Rotate** any secret that has ever been exposed to a log, screenshot, or pull request. Rotate API keys on a schedule.
- **Principle of least privilege** for every key. A read-only DB key, a write-only S3 upload key, a Stripe restricted key scoped to the products you use.
- **Don't log secrets.** Configure logger redaction:
  ```ts
  // pino
  const logger = pino({ redact: ['req.headers.authorization', 'password', '*.token', '*.apiKey'] });
  ```
- **Generate strong secrets**: `openssl rand -base64 48` or `crypto.randomBytes(48).toString('base64url')`. JWT signing secrets should be ≥ 256 bits.

---

## 11. Dependencies and supply chain

- **`npm audit` / `pnpm audit` / `bun audit`** in CI, blocking on high+critical.
- **Renovate or Dependabot** for automated PRs.
- **Lockfiles** committed (`package-lock.json`, `pnpm-lock.yaml`, `bun.lockb`).
- **Pin GitHub Actions by SHA**, not tag (`actions/checkout@<sha>`).
- **Review postinstall scripts** before adding new packages; they execute arbitrary code.

---

## 12. Logging, monitoring, and error handling

- **Structured logs** (pino, winston) with request ID correlation.
- **Never log** PII (full name, ID number, full card number), secrets, or full request bodies on auth routes.
- **Mask PII**: for banking/KYC systems, log `user_id`, not email or KTP. Indonesian UU PDP and global GDPR both require this.
- **Alert on**: auth failure spikes, 500 spikes, new admin-role assignments, privileged data exports, deploys.
- **Do not leak stack traces to clients.** Generic 500 message to user, full trace to server logs with a request ID the user can quote in support.

---

## 13. Defense in depth

No single control is enough. Stack them:

1. **Network** — WAF/Cloudflare, IP allow-list for admin
2. **Transport** — TLS, HSTS
3. **Headers** — CSP, HSTS, XFO
4. **App** — auth, authz, validation, encoding, rate limits
5. **Data** — least-privileged DB user, encryption at rest, RLS
6. **Secrets** — vault, rotation, redaction
7. **People** — code review, 2FA on GitHub and cloud consoles, audit trails

Assume any one layer will fail. If you remove your CSP, input validation still stops XSS. If you bypass input validation, the ORM's parameterized queries still stop SQL injection. If all of those fail, the DB user has no `DROP` privilege.

---

## 14. OWASP Top 10 checklist (quick)

Use this as a pre-ship gate. Full detail in `references/owasp-top-10.md`.

- [ ] **A01 Broken Access Control** — every resource handler checks ownership
- [ ] **A02 Cryptographic Failures** — TLS everywhere, argon2id/bcrypt, no custom crypto
- [ ] **A03 Injection** — parameterized queries, input validation, no shell concat
- [ ] **A04 Insecure Design** — threat model before building auth/payment flows
- [ ] **A05 Security Misconfiguration** — Helmet, no default creds, `NODE_ENV=production`, disabled debug
- [ ] **A06 Vulnerable Components** — audit in CI, Renovate/Dependabot on
- [ ] **A07 Identification & Authentication Failures** — rate-limited login, MFA, generic errors, secure session cookies
- [ ] **A08 Software & Data Integrity** — lockfiles, SHA-pinned actions, signed releases
- [ ] **A09 Logging & Monitoring Failures** — structured logs, alerts on auth anomalies, PII redaction
- [ ] **A10 Server-Side Request Forgery** — allow-list outbound URLs, block link-local/private IPs when fetching user-supplied URLs

---

## 15. Stack-specific notes

**Fastify** has first-class JSON Schema validation, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/cors`, `@fastify/csrf-protection`. Prefer these over generic Express ones when on Fastify.

**Bun + Hono** is fast but relatively new. Use `hono/secure-headers`, `hono/cors`, `hono/csrf`, and a Zod middleware. `bun audit` (Bun 1.1+) for dep scanning.

**Prisma** is safe by default — avoid `$queryRawUnsafe` and `$executeRawUnsafe`. For Postgres multi-tenant apps, combine Prisma with RLS.

**Next.js**: Server Actions are CSRF-protected by default; `middleware.ts` is the right place for auth and header enforcement; `next.config.js` `headers()` sets security headers for all routes.

**Banking/fintech (Indonesia — UU PDP, POJK)**: add PII redaction in logs, audit trails for every privileged action, segregated admin access, MFA on every employee account, and third-party auditor evidence (quarterly pentest, yearly ISO 27001 review).

---

## When you find a vulnerability

Respond in this format:

1. **Risk** — one sentence. Include CWE/OWASP category.
2. **Where** — quote the exact file/line.
3. **Exploit** — one concrete attack scenario in plain language.
4. **Fix** — working code, not just "sanitize the input".
5. **Related** — other places in the codebase likely to have the same bug.

Do not sugar-coat. A missing authorization check in a banking app is not a "consideration" — it's a critical bug that must block the release.
