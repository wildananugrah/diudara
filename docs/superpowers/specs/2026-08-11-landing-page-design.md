# Landing Page — Design Spec

Date: 2026-08-11
Status: Approved for planning
Parent spec: `docs/superpowers/specs/2026-08-07-diudara-mvp-design.md`

## 1. Purpose

`apps/web/src/App.tsx` has **no route for `/`**. Its final route is a catch-all:

```tsx
<Route path="*" element={<Navigate to="/c/tidak-ada" replace />} />
```

So the bare domain — `https://diudara.mhamzah.id` — falls through and lands on the public checkout
page for a community whose slug is literally "does not exist", rendering *"Komunitas tidak
ditemukan."* Anyone typing the domain is told a specific community is missing, when in fact none
was ever named.

This adds a landing page at `/` and stops the catch-all lying.

## 2. Scope

**In scope:**
- `LandingPage` at `/`, a full marketing page in Bahasa Indonesia
- Fixing the catch-all so an unknown path says "halaman tidak ditemukan" rather than redirecting
  to a fabricated community slug
- Styles appended to the existing `apps/web/src/styles.css`
- Component tests

**Out of scope:**
- A pricing section (§5)
- Signup as a distinct screen — the call to action points at the existing `/dashboard/login`,
  which already handles both login and signup
- Any API change, any new dependency, any CSS framework, analytics, or a cookie banner

## 3. Where it lives

`apps/web/src/pages/LandingPage.tsx`, beside `CheckoutPage.tsx` and `StatusPage.tsx`. It is a
public page, not a dashboard screen, so it does not go under `dashboard/`. It takes no props,
fetches nothing, and holds no state — which is what makes it testable in one render.

Styling is plain hand-written CSS appended to `apps/web/src/styles.css`, matching the conventions
already there (`.card`, `.section`, `.muted`, `.stack`, `.row`). New rules are prefixed
`.landing-` so they cannot collide with the dashboard's.

`styles.css` is already 718 lines in one unscoped file — a known carry-forward. This spec does
**not** split it: doing so while adding to it would mix two changes and make both harder to
review. The prefix keeps the addition self-contained for whoever does split it later.

## 4. Content

Bahasa Indonesia throughout, matching the rest of the product.

| Section | Contains |
|---|---|
| Hero | The core promise — a WhatsApp or Telegram group the creator already runs becomes a paid community, with payment and access handled automatically. Primary call to action. |
| The problem | What the PRD validated: creators chase transfers by hand, and have no systematic way to handle members who stop paying. |
| How it works | Three steps — create a community and its tiers; share the checkout link; members pay and get access automatically. |
| Features | QRIS and e-wallet payment, automatic Telegram access, automatic renewal reminders and revocation, a dashboard with revenue and churn, and the Bahasa Indonesia AI co-builder. |
| Closing | Repeat call to action → `/dashboard/login`. |

## 5. What the page must not claim

The product is pre-revenue. There is no live Xendit account, no Telegram bot token, and no
completed deployment. A marketing page was chosen deliberately and with that understood, so the
copy may present the product's capabilities — but three specific claims are forbidden because
they would be false rather than aspirational:

1. **No fabricated social proof.** No testimonials, no customer counts, no "dipercaya oleh 500+
   kreator", no logos. These are claims about real people who do not exist.
2. **No claim that WhatsApp groups are gated.** Phase 4 established this is impossible through
   Meta's official API — there is no endpoint to add a participant, and groups cap at 8 members
   against a product targeting 50-2,000. **WhatsApp is notification-only.** The PRD's headline
   ("nempel di WA/Telegram") implies otherwise; repeating it would describe a product that does
   not exist. The copy says Telegram for access, WhatsApp for notifications.
3. **No pricing.** DIUDARA's platform fee has never been decided — the 5% used when creating the
   Xendit split rule was an explicit placeholder. A page quoting a rate would commit publicly to a
   number nobody has chosen. There is no pricing section at all; it is added when the fee is real.

## 6. The catch-all

Today an unknown path redirects to `/c/tidak-ada`, which renders the checkout page's not-found
state. That was defensible when the app had no front door and nobody was expected to type a URL.
It is wrong now: it reports the wrong problem, and it puts a fake slug in the address bar.

Replace it with `apps/web/src/pages/NotFoundPage.tsx` — a small component with Indonesian copy
saying the page was not found and a link home — rendered **in place**. No redirect, so the URL the
visitor actually typed stays in the address bar, which is what makes the message diagnosable. Its
own file rather than a second export from `LandingPage.tsx`, because the two are unrelated
screens that happen to be added together.

The dashboard's own catch-all (`/dashboard/*` → `/dashboard`) is unchanged; it is correct.

## 7. Testing

- The page renders its heading and its calls to action.
- Every call to action links to `/dashboard/login`.
- **`/` renders the landing page and does not redirect** — this is the regression the whole change
  exists to prevent.
- An unknown path renders the not-found element and **does not** navigate to `/c/tidak-ada`.
- No `dangerouslySetInnerHTML` anywhere on the page.

Note for whoever writes these: a failing `expect(<DOM element>).toBeNull()` **hangs `bun test`**
(measured at 178 s and 335 MB). There is a source-scan guard at
`apps/web/src/test/no-hanging-dom-assertions.test.ts`. Count elements or assert booleans.

## 8. Mobile first

Unlike the dashboard, where desktop-first was acceptable because a creator managing tiers is
plausibly at a laptop, this page is the one a creator opens from a link on their phone. It is
mobile-first, with a single column that widens on larger screens.
