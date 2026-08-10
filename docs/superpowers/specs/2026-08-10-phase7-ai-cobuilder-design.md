# Phase 7: AI Co-Builder — Design Spec

Date: 2026-08-10
Status: Approved for planning
Parent spec: `docs/superpowers/specs/2026-08-07-diudara-mvp-design.md`
Builds on: Phases 1-6 (merged: `d0904b8`, `565d43a`, `c78ad11`, `e722276`, `8f3acff`, `ca9c04f`)

## 1. Purpose

The PRD's differentiator is that setting up a paid community should take **under 15 minutes**, with
an AI helping in Bahasa Indonesia rather than the creator facing empty forms:

> *"AI co-builder membantu setup komunitas, channel, dan welcome message otomatis dalam Bahasa
> Indonesia."*

Phase 6 gave creators forms. Phase 7 gives them a conversation that fills those forms in.

## 2. The central design decision: the AI never writes to the database

The chat produces a **draft** — community name, description/niche, one to three suggested tiers
with prices, and a welcome message. That draft is returned to the browser, the creator **edits it in
a normal form**, and saving goes through the **existing Phase 2 endpoints** (`POST /communities`,
`POST /communities/:id/tiers`) that a manual creator already uses.

This is the crux of the phase. A hallucinated tier price must not become real money because someone
clicked "yes". Routing the save through the existing endpoints means the AI path **cannot bypass a
single rule the manual path enforces** — the same Zod validation, the same creator scoping, the same
409s.

Rejected: having the AI create the community directly on confirmation. It is faster for the creator
and puts an LLM's output into the money path behind only a yes/no gate.

## 3. Scope

**In scope:**
- `AiProviderPort` with `OpenRouterAiAdapter` (unverified — §7) and a deliberately hostile
  `FakeAiAdapter`
- A Bahasa Indonesia onboarding chat: niche, target audience, pricing
- A structured, Zod-validated draft (community + tiers + welcome message)
- `ai_conversation` / `ai_message` so a creator can resume, and `ai_usage` for the spend cap
- A dashboard chat screen that hands its draft to the existing create forms
- **Carry-forwards this phase needs anyway:** `GET /communities/:id` and `GET /payment-account`

**Out of scope (with the phase that owns it):**
- Prompt-to-page generation, workflow automation — the PRD's full "Pulse-ID" (Fase 4)
- AI-generated course content — Fase 2
- Streaming responses (§6)
- Any AI write path to the database

## 4. Decisions settled during brainstorming

| Question | Decision | Reason |
|---|---|---|
| OpenRouter key | None — build against a fake | Nothing blocks; but see §7, this is the third unverified adapter |
| Output scope | Draft, creator edits, saved via existing endpoints | An LLM's output must not reach the money path unmediated |
| Cost control | Per-creator daily cap, counted in Postgres | The only option that bounds spend rather than slowing it |
| Request handling | Synchronous with a timeout | A chat turn is interactive; an outbox would add polling for no benefit |

## 5. Two failure modes that only appear with a real model

### 5.1 Malformed output

An LLM asked for JSON will eventually return prose, truncated JSON, JSON inside a code fence, or a
refusal. **The port's contract is that it returns parsed, schema-conforming data or throws — never
raw model text.** The adapter parses defensively; the use-case retries **once**, then fails
honestly with a message the creator can act on.

The fake adapter must be able to produce each of these, so the handling is exercised even without a
key. A fake that always returns clean JSON proves the happy path and nothing else.

### 5.2 Prompt injection

A creator types free text that reaches a model whose output is then rendered in the dashboard and
pre-fills a form. **Model output is untrusted data, never instructions.** Concretely:

- Zod-validated and length-bounded before it leaves the adapter
- rendered as text — React escapes by default, and there must be no `dangerouslySetInnerHTML`
  anywhere near it
- the draft is **still** saved through the normal endpoints, so injection cannot skip validation

The realistic risk is not a creator attacking themselves — it is a creator pasting text from
elsewhere (a competitor's page, a customer message) that carries instructions.

## 6. Request handling

Synchronous, with a bounded timeout and a clear error. A chat turn is inherently interactive — the
creator is sitting there — so the Phase 4 outbox pattern would add a polling loop for no benefit.

Streaming is deliberately deferred: it feels better and is what creators expect from an AI product,
but it means SSE or chunked responses through the Vite proxy, a streaming parser, and
partial-failure handling — meaningful surface for a phase whose adapter is already unverified.

## 7. Honest limitation: the third unverified adapter

`OpenRouterAiAdapter` **cannot be verified** — there is no key. That is now true of Xendit,
Telegram, and OpenRouter.

It hurts most here. A fake that returns clean JSON proves the *port contract*, not how a real model
behaves — and unlike a payment API, an LLM's output shape is genuinely unpredictable. The
mitigations are: the hostile fake (§5.1) and treating malformed output as an expected path rather
than an error case.

**Before this is exposed to real creators**, run it against a real model and check: does it return
valid JSON reliably at the chosen temperature; does it answer in Indonesian; does it refuse
anything unexpectedly; and does the retry actually help or just double the bill.

## 8. Cost is bounded in the database

`ai_usage` counts messages per creator per **UTC day**. The check and increment happen in **one
statement**, so two concurrent requests cannot both pass a limit with one slot left — the same
database-arbitrates rule every phase since 2 has followed.

Over the cap → **429** with a message saying when it resets.

There is no live bill today, because there is no key. That is exactly why the guard goes in now:
Phase 3 shipped a Critical where a safety guard was correct but its trigger was never established,
and a cost guard added *after* a key exists is the same shape.

## 9. Schema

- `ai_conversation` — `id`, `creator_id`, `status`, `created_at`, `updated_at`
- `ai_message` — `id`, `conversation_id`, `role` (`user`/`assistant`), `content`, `created_at`
- `ai_usage` — `creator_id` + `usage_date` unique, `message_count`

Conversations hold what a creator typed about their business, so they are **creator-scoped at the
repository**, like every read since Phase 2. Cross-creator returns **404, not 403**.

## 10. Errors

| Condition | Behaviour |
|---|---|
| Daily cap reached | 429, with the reset time |
| Model returns malformed output | One retry, then a clear failure — never a half-parsed draft |
| Model refuses | Surfaced as a normal assistant message, not an error |
| Provider timeout or 5xx | Clear error; the conversation is preserved so the creator can retry |
| No AI provider configured | The chat screen is hidden rather than broken (§11) |
| Cross-creator conversation | 404 |

## 11. Configuration

`OPENROUTER_API_KEY` and a model id from the environment, following the **`NODE_ENV` allowlist**
Phase 3 established: only `development`/`test` may relax, everything else including `undefined`
throws.

Unlike payments, an absent AI provider is **not** a reason to refuse to boot — the product works
fine without a co-builder. So: absent key → the fake adapter in dev/test, and in production the API
boots with the AI feature **disabled and the chat screen hidden**, rather than offering a button
that always errors.

## 12. Testing

- Use-case tests against the hostile fake: prose instead of JSON, truncated JSON, a code fence, a
  refusal, an injection attempt in the creator's input
- A test that the retry happens **once**, not unboundedly
- A test that the daily cap holds under **concurrent** requests, pinned deterministically — a bare
  `Promise.all` has produced a false pass five times in this project
- A test that the draft is never written to the database by the AI path
- Cross-creator conversation access returns 404 and leaks nothing
- A dashboard test that model output is rendered as text, not HTML

## 13. Carry-forward items addressed here

- `GET /communities/:id` — five Phase 6 screens refetch the whole list because it does not exist
- `GET /payment-account` — the payments-connected flag is currently per-browser, and the co-builder
  should know whether a creator can take money before proposing paid tiers

## 14. Carry-forwards explicitly NOT addressed

Recorded so they are not assumed done:
- **Deployment plumbing** — no `start` script, no Dockerfile, no SPA fallback or same-origin proxy
  for production. Phase 6 built a browser app that nothing can serve. This is now blocking and
  belongs in the next phase.
- **Xendit and Telegram remain unverified**, now for six phases.
- The Postgres constraint-violation log leak (`CONTRIBUTING.md`) still needs a pre-deploy decision.
