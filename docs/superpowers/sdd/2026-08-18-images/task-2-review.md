# Task 2 review — `MediaStoragePort`, a fake, and the Biznet S3 adapter

Reviewed: `5389990..c2fa86f` (11 files, 632 insertions, 0 deletions).
Method: read + independent mutation testing + an offline runtime probe of Bun's S3 API. The report's
test evidence was not re-run wholesale; every claim below that matters was re-derived.

## Verdicts

**Spec compliance: ✅**
**Task quality: findings — 2 Important, 5 Minor. No Critical.**

---

## 1. `s3-media-storage.adapter.ts` — the file no test will ever cover

This is the part of the diff that only a careful read gates, so it gets the most space.

### API reality check — verified two ways

Against the installed typings (`node_modules/.bun/bun-types@1.3.14/.../s3.d.ts`) **and** against the
runtime, by constructing a client offline and presigning a key (no network needed for either):

| Used at | Call | Verified |
|---|---|---|
| `:32` | `new S3Client({accessKeyId, secretAccessKey, bucket, endpoint, region})` | `constructor(options?: S3Options)`; `S3Options` declares all five (s3.d.ts:109-217). Real. |
| `:41` | `client.write(key, bytes, { type: "image/webp" })` | `write(path, data: …\|ArrayBufferView\|…, options?: S3Options): Promise<number>` (s3.d.ts:940-957). `type` comes from `BlobPropertyBag`, which `S3Options` extends. `Uint8Array` satisfies `ArrayBufferView`. Real. Return value awaited and discarded — correct, the byte count is not needed. |
| `:45` | `client.file(key)` | `file(path, options?): S3File` (s3.d.ts:889). Real. |
| `:46` | `file.exists()` | `exists(): Promise<boolean>` (s3.d.ts:595). Real. |
| `:47` | `file.arrayBuffer()` | `S3File extends Blob`; confirmed present at runtime. Real. |
| `:52-53` | `file.delete()` | `delete(): Promise<void>` (s3.d.ts:695). Real. |

Runtime probe output (offline, `Bun 1.3.14`):

```
S3Client: function      S3Error: undefined      s3 default: object
client methods: [ write, file, delete, unlink, exists, size, stat, presign, list ]
file   methods: [ exists, arrayBuffer, bytes, delete, unlink, write, text, stream, slice, stat, presign ]
presign("posts/x/full.webp") -> https://s3.example.invalid/bk/posts/x/full.webp
```

Three things that probe settles and a read alone could not:

- **Addressing is path-style** (`<endpoint>/<bucket>/<key>`). `S3Options.virtualHostedStyle` defaults
  to `false` (s3.d.ts:219-229), and the adapter correctly does not set it. This is the right default
  for an S3-compatible provider addressed by an explicit endpoint. Had it been virtual-hosted, every
  request against Biznet Gio NEO would have gone to a hostname that does not exist.
- **Endpoint normalisation is forgiving**: `https://s3.x.invalid`, `https://s3.x.invalid/` (trailing
  slash) and bare `s3.x.invalid` all produce the identical URL. An operator pasting a trailing slash
  out of the portal will not produce a double-slashed key.
- **No `acl` is passed**, so objects land private. §5.1's "no bucket URL ever escapes" is not
  weakened by a `public-read` default that isn't there.

**Conclusion: the method names, argument shapes and return types are all real and used correctly.**
Nothing here will fail at runtime for an API-shape reason.

### `put` writes with a content type — ✅

`{ type: "image/webp" }` is the documented content-type option (s3.d.ts:174, and the `file.write`
example at s3.d.ts:626-630 uses it identically).

### `get` returns null rather than throwing when absent — ✅, with a caveat (Minor 3 below)

### `remove` is idempotent and removes both variants — ✅ on both counts, but see Important 1

### Key layout confinement — ✅ in code

`grep -rn 'posts/\${\|\.webp'` across `apps/` and `packages/` returns exactly two hits, both in
`s3-media-storage.adapter.ts` (`:19` docstring, `:37` code). The fake deliberately uses a *different*
layout (`${id}:${variant}`), so no consumer can accidentally depend on the bucket shape via the fake
either. `MEDIA_STORAGE_ENV_VAR_NAMES` holds env-var names, not key fragments. Nothing else in the
diff composes a key. (One documentation-only exception — Minor 4.)

---

## 2. The scope ruling — independently verified, and it holds

`git diff --numstat` confirms **0 deletions in all 11 files**. But an insertion count cannot rule out
a meaning change, so I checked the specific failure mode directly.

**The dangerous case would be an added env var inside a `.toThrow()` block** — there, satisfying a
new guard can make an existing throw-assertion pass on a *different* throw. I enumerated all nine
`REAL_S3_CONFIG` / literal-S3-block insertion sites:

| Site | Assertion it sits inside |
|---|---|
| `bootstrap.test.ts:1604` (payments disabled) | `.not.toThrow()` + `payments === null` |
| `bootstrap.test.ts:1950` (callback token, fully configured) | `.not.toThrow()` |
| `bootstrap.test.ts:1978` (callback token absent) | `.not.toThrow()` + `xenditCallbackToken` undefined |
| `bootstrap.test.ts:2351` (email disabled) | `.not.toThrow()` + `email === null` |
| `bootstrap.test.ts:2971` (AI disabled) | `.not.toThrow()` + `aiProvider`/`sendAiMessage` undefined |
| `bootstrap.test.ts:3237` (streaming disabled) | `.not.toThrow()` + `streamingProvider` undefined |
| `payment-account.test.ts:104` | HTTP status assertions |
| `public-community.test.ts:377,440,478` | HTTP status assertions |
| `communities.test.ts:63` (`PAYMENTS_DISABLED_ENV`) | HTTP status assertions |

**Not one is a `.toThrow()` site.** Every one is a "this must boot, and then X must be disabled"
test, where the added S3 config is *strictly necessary* for the test to reach its own subject at all
— and where the assertion that follows is unchanged and still discriminating. Adding S3 config
cannot make any of them pass for a new reason; it can only stop them failing for an unrelated one.

The single new `.toThrow()` test asserts `/S3_ACCESS_KEY_ID.*permitted ONLY/s` — a phrase unique to
`selectMediaStorage`'s block-boot message — so it cannot be satisfied by another guard's throw either.

**Your reasoning is confirmed, and on the stronger ground than the stat summary gave you.**

---

## 3. `test-env-preload.ts` — your reading confirmed, plus one reason you didn't have

Confirmed, and there is a second justification the comment does not mention:

- `apps/api/.env` is gitignored and today contains no `S3_*` names — so this closes the hole
  *before* it opens, exactly as the comment claims, matching the `TELEGRAM_BOT_TOKEN` /
  `FONNTE_API_TOKEN` / `XENDIT_SECRET_KEY` precedent it is appended to.
- **The extra reason:** Bun's own `S3Client` falls back to `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
  `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` *as its default credential source* (s3.d.ts:138-197 — the
  same five names, by coincidence of naming). So without this deletion, a developer's local bucket
  would be reachable not only through `selectMediaStorage` but through any bare `Bun.s3` usage
  anywhere in the suite. The hole is wider than the comment says, and this change closes all of it.

**Confirmed, not contradicted.** This is the right change and belongs in the diff.

---

## 4. Bootstrap selection logic — mutation-tested, no subtle condition bug

The structure is `setCount === entries.length` → real; `setCount > 0` → throw half-configured;
`isRelaxedNodeEnv` → fake; else throw. There is no `||`/`&&` to get wrong: the count comparison
makes "some but not all" a distinct third branch that cannot reach either adapter. I confirmed the
tests actually bind that structure rather than merely coexisting with it — six independent mutations,
each reverted before the next:

| Mutation | Result |
|---|---|
| `setCount === entries.length` → `setCount > 0` (partial config selects the real adapter) | **4 fail** |
| `setCount > 0` → `setCount > 99` (half-configured guard removed) | **2 fail** |
| `isRelaxedNodeEnv(env.nodeEnv)` → `true` (fake everywhere; block-boot removed) | **2 fail** |
| `presentOrUndefined(env.accessKeyId)` → raw (blank string counts as configuration) | **1 fail** |
| Real-branch log line prints `accessKeyId`/`secretAccessKey` | **1 fail** (`keeps the credentials out of the startup log line`) |
| `fake.remove` deletes only `full` / `get` returns an empty object instead of `null` / `key` drops the variant | **1, 2, 1 fail** |

Every behaviour the brief requires has at least one test that dies when it is inverted. The
asymmetry versus messaging/payments is implemented as specified, and it is explained — three times
(the `selectMediaStorage` docstring case 4, the inline `// BLOCK BOOT` comment at the throw, and the
`Dependencies.mediaStorage` field docstring), each saying *why* rather than *what*, which matches
`RELAXED_NODE_ENVS`'s and `logProviderChoice`'s own house style.

`tsc --noEmit`: clean, exit 0.

---

## 5. Global constraints

| Constraint | Result |
|---|---|
| No network calls in tests | ✅ No `fetch(`/`http.`/`axios`/`request(` on any added line. `S3Client` construction is lazy (probed: constructing against a non-resolving endpoint does no I/O). See Important 2 for the forward-looking caveat. |
| No real credential anywhere | ✅ Every fixture value is obviously synthetic: `test-s3-access-key`, `test-s3-secret-key`, `test-bucket`, `https://s3.test.example.com`, `id-jkt-1`, `AKIA-secret`. `.env.example` carries names with empty values only, and a test enforces that (`expect(lines.some(l => l.startsWith("S3_BUCKET="))).toBe(false)`). **No Critical here.** |
| No AWS SDK | ✅ `git diff` on `package.json` / `apps/api/package.json` / `bun.lock` is empty. No `@aws-sdk` anywhere in the repo. |
| Missing bucket blocks boot outside relaxed `NODE_ENV`, with a comment explaining why | ✅ Implemented and explained in three places; mutation-verified. |
| Tests assert literals, not the constant under test | ✅ for the block-boot test, which iterates the literals `[undefined, "staging", "prod", "PRODUCTION", "dev", "", "production"]`. The fake-selection test iterates `[...RELAXED_NODE_ENVS]`, but that is the pre-existing house pattern (`bootstrap.test.ts:1245, 1288, 1322`) and is safe here because the literal-driven negative test would catch any widening of the set. |
| TDD with a recovered red phase | ✅ for the fake adapter — the report documents stubbing a deliberately-wrong body so all three tests failed on their own `expect()`, and my mutations M6-M8 reproduce exactly those failures, so the claimed red phase is real and reproducible. ⚠️ See Minor 5 for the 13 bootstrap tests. |
| Documents WHY, not WHAT | ✅ Strong. The comments explain the asymmetry, the field's non-optionality, the placement next to messaging, and the preload hazard — none of them restate the code. |

---

# Findings

## Important

### I1 — `remove()` swallows every error class, not just a missing object
`apps/api/src/infrastructure/storage/s3-media-storage.adapter.ts:50-54`

```ts
await Promise.all([
  this.client.file(this.key(id, "full")).delete().catch(() => {}),
  this.client.file(this.key(id, "thumb")).delete().catch(() => {}),
]);
```

The comment says "absent objects are not an error" — but S3 `DELETE` is *already* idempotent: deleting
a non-existent key returns 204, not an error. The `.catch(() => {})` therefore buys nothing the brief
asked for, and what it actually does is make **expired credentials, a wrong bucket name, a revoked
key, a 403, and a network failure all indistinguishable from success**. `remove()` resolves cleanly,
the caller believes the bytes are gone, and nothing anywhere logs that they are not. Orphaned objects
then accumulate in a bucket the owner pays for, invisibly and permanently, with no signal until
someone reads a billing line.

This is not exploitable — delivery goes through the API, which reads the DB row, so a
failed-to-delete object stays unreachable — which is why it is Important and not Critical. But it is
the one place in this file where a real production failure is designed to be silent, and this review
is the last gate before it runs against a real bucket.

Fix: keep the catch (so one variant's failure does not abandon the other) but log it.
`.catch((err) => console.error(\`[media] failed to remove ${variant} for ${id}\`, err))` costs
nothing and converts a silent leak into a grep-able line. Task 8's orphan sweep will want this signal.

Note this came verbatim from the brief, so it is an inherited flaw rather than an implementer error —
but the brief is not a gate, this review is.

### I2 — The production-simulating tests now construct a *live* `S3MediaStorageAdapter`, and nothing warns about it
`apps/api/src/bootstrap.test.ts:1656-1669` (`REAL_S3_CONFIG`), and the equivalent literal blocks at
`apps/api/src/routes/communities.test.ts:63-71`, `apps/api/src/routes/payment-account.test.ts:104-111`,
`apps/api/src/routes/public-community.test.ts:377-384, 440-447, 478-485`

Because these blocks run under `NODE_ENV=production`, the fake is (correctly) forbidden, so
`bootstrap()` in nine test scenarios now returns `Dependencies` holding a genuine
`S3MediaStorageAdapter` pointed at `https://s3.test.example.com` — a hostname that does not resolve.

Today this is harmless: construction is lazy (verified by probe — no I/O), nothing consumes
`mediaStorage` yet, and the suite is green. **But Task 4 adds `POST /users/media` and the two `GET`
delivery routes.** The first route test in one of these production blocks that touches a media path
will attempt a real DNS lookup and HTTPS request from inside the suite. That violates "no network
calls in tests", and it will not present as a design error — it will present as a hang or a flaky
timeout that someone spends an afternoon on.

`REAL_S3_CONFIG`'s docstring explains *why the constant exists* (block-boot forced it) but says
nothing about *what it wires*. Fix now, cheaply: add one sentence to that docstring — "this selects a
REAL `S3MediaStorageAdapter`; these blocks must never exercise a media route, override
`deps.mediaStorage` with a `FakeMediaStorageAdapter` if they ever need to" — and the same note in the
three route files. Structural alternative: have those blocks build `Dependencies` from `bootstrap()`
and then override `mediaStorage`.

## Minor

### M1 — The entire `.env.example` documentation block is untested; the test that claims to cover it does not
`apps/api/src/bootstrap.test.ts:1297-1324`

The test's own docstring says the file "must ALSO say what makes this pair unlike every other one in
the file: absence block-boots outside the allowlist rather than degrading". Its assertions do not
check that. `expect(example).toContain(nodeEnv)` for `"development"`/`"test"` is near-tautological —
those strings already appear 13 and 17 times elsewhere in `.env.example`.

Proved by mutation: I replaced the whole 45-line explanatory block with
`# Image storage. Biznet Gio NEO. FakeMediaStorageAdapter.` — deleting the block-boot explanation, the
set-together-or-not-at-all rule, the Access-page pointer, the key-layout note and the UNVERIFIED
warning — and `bootstrap.test.ts` stayed **156 pass / 0 fail**.

The variable-name and empty-value assertions above it *are* load-bearing and good. The prose ones are
not. Fix: assert a phrase unique to this block, e.g. `expect(example).toContain("BLOCKS BOOT")`.
(The weak pattern is inherited from the pre-existing streaming test at `:1288`/`:1322`, so this is a
pre-existing habit rather than something this task invented.)

### M2 — `.env.example` restates the key layout, contradicting its own invariant
`apps/api/.env.example` (the "The key layout (posts/<id>/full.webp, posts/<id>/thumb.webp) lives ONLY
inside s3-media-storage.adapter.ts" comment)

The sentence asserting that the layout lives in exactly one file is itself a second place the layout
is written down. It is inert — a comment in a config example, no code composes a key from it, and it
cannot escape into an HTTP response — so this is not the Important finding your brief describes.
But it is the first place a future developer would copy the layout from, and it makes the invariant
technically false the moment it is read literally. Fix: say *that* the layout is owned by
`s3-media-storage.adapter.ts` without reproducing it.

### M3 — `get()` costs two round trips and has a TOCTOU window that produces a 500 where the port promises a 404
`apps/api/src/infrastructure/storage/s3-media-storage.adapter.ts:44-48`

`exists()` (a HEAD) followed by `arrayBuffer()` (a GET) doubles the bucket round trips on the image
delivery hot path, and if the object is removed between the two calls, `arrayBuffer()` throws — so
`get` rejects instead of returning `null`, exactly the outcome
`media-storage.port.ts:12`'s docstring forbids ("a media row whose bytes are missing must 404, not 500").
Narrow window, and Task 8's sweep is the only thing that would race it.

**Mitigating, and why I am not rating this higher:** Bun 1.3.14 exports no `S3Error` class
(verified: `typeof Bun.S3Error === "undefined"`), so there is no typed way to catch-and-distinguish
`NoSuchKey` from a real failure. The exists-first pattern is the pragmatic choice available today.
Flag it for Task 4 when the delivery route makes the second round trip measurable; a
`try { await file.bytes() } catch` with a string/status check on the error would fix both halves at
once. Related nit: `file.bytes()` returns a `Uint8Array` directly and would avoid the
`new Uint8Array(await file.arrayBuffer())` copy on every image served.

### M4 — The port buffers whole images where the spec describes streaming
`apps/api/src/application/ports/media-storage.port.ts:2-5`, versus
`docs/superpowers/specs/2026-08-18-images-design.md:101-104` ("The two GET routes read from the
bucket and **stream** the bytes through the API")

`MediaObject.bytes: Uint8Array` forces every delivery request to hold a full-size photo in the API
process. Bun's `S3File.stream()` exists (confirmed at runtime) and would be the natural fit. The port
shape came from the brief verbatim, so this is a brief-level tension to raise before Task 4 commits
to it, not an implementer defect — but concurrency times image size is the number that will decide
whether it matters.

### M5 — Red-phase evidence covers 3 of the 16 new tests
`.superpowers/sdd/2026-08-18-images/task-2-report.md`, "Red phase"

The report documents a properly recovered red phase for `fake-media-storage.adapter.test.ts` (the
stub-with-a-wrong-body technique is the right answer to "a module that fails to load is not a red
phase", and my mutations reproduce those exact three failures). It documents **no red phase at all**
for the 13 `selectMediaStorage` / `bootstrap()` tests, which are the ones guarding the hard
constraint.

I substituted for the missing evidence with six mutations (section 4 above) and all thirteen tests
are genuinely discriminating, so the substantive guarantee holds and no rework is needed. Recording
it so the gap in the report is not mistaken for verified coverage next time.

---

## What I checked and found nothing wrong with

- No credential, key, token or real endpoint anywhere in the diff, in any file, including comments
  and fixtures. `.env.example` values are empty and a test enforces it.
- No dependency added; no AWS SDK; Bun's built-in client only.
- No network call added to any test.
- The key layout appears in no code outside `s3-media-storage.adapter.ts`.
- Path-style addressing (correct for Biznet Gio NEO), private-by-default ACL, forgiving endpoint
  normalisation — all verified by runtime probe, not inference.
- The block-boot asymmetry is real, deliberate, and explained in three places.
- `git status` in the worktree is clean; every mutation I applied was reverted.
