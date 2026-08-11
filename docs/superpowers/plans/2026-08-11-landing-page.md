# Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/` renders a Bahasa Indonesia marketing page instead of falling through a catch-all to a
fabricated community slug, and an unknown path says so honestly.

**Architecture:** Two stateless public page components beside the existing `CheckoutPage`. The
route table is extracted from `App.tsx` into an exported `AppRoutes` so routing itself can be
tested in a `MemoryRouter` — without that, the regression this change exists to prevent cannot be
asserted. Styles are appended to the existing `styles.css` under a `.landing-` prefix.

**Tech Stack:** Vite, React, react-router-dom v7, `bun:test`, `@testing-library/react` + happy-dom.

## Global Constraints

From `docs/superpowers/specs/2026-08-11-landing-page-design.md`.

- **All copy in Bahasa Indonesia**, matching the rest of the product.
- **No fabricated social proof** — no testimonials, no customer counts, no "dipercaya oleh 500+
  kreator", no logos. Those are claims about real people who do not exist.
- **Never imply WhatsApp groups are gated.** Meta's official API has no endpoint to add a
  participant and caps groups at 8 members against a product targeting 50-2,000. **Telegram for
  access, WhatsApp for notifications.** The PRD's headline implies otherwise; repeating it would
  describe a product that does not exist.
- **No pricing section.** The platform fee has never been decided; the 5% used for the Xendit
  split rule was an explicit placeholder.
- **No new dependency, no CSS framework.** Plain hand-written CSS appended to
  `apps/web/src/styles.css`, new rules prefixed `.landing-`.
- **The catch-all renders in place; it must not redirect.** The URL the visitor typed stays in the
  address bar — that is what makes the message diagnosable.
- **Mobile-first.** Single column that widens on larger screens.
- **A failing `expect(<DOM element>).toBeNull()` hangs `bun test`** (measured: 178 s, 335 MB).
  There is a source-scan guard at `apps/web/src/test/no-hanging-dom-assertions.test.ts`. Count
  elements or assert booleans instead.
- Root gates: `bun run test` and `bun run typecheck` from the repo root — **`bun run test`, never
  bare `bun test`**, which from the root produces ~123 spurious failures because `apps/web` needs
  its own bunfig preload for happy-dom.

---

### Task 1: `AppRoutes`, the landing page, and the route at `/`

**Files:**
- Create: `apps/web/src/pages/LandingPage.tsx`
- Create: `apps/web/src/pages/LandingPage.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css` (append)

**Interfaces:**
- Produces: `export function AppRoutes()` from `apps/web/src/App.tsx` — the `<Routes>` element with
  no router around it, so tests can wrap it in a `MemoryRouter`. `export default function App()`
  stays, and becomes `<BrowserRouter><AppRoutes /></BrowserRouter>`.
- Produces: `export default function LandingPage()` from `apps/web/src/pages/LandingPage.tsx` —
  takes no props, fetches nothing, holds no state.
- Task 2 consumes `AppRoutes` to test the catch-all.

**Why the extraction.** `App` currently renders `BrowserRouter`, which reads `window.location`. A
test cannot put it at `/` without driving the real URL. Exporting the route table lets a test
render `<MemoryRouter initialEntries={["/"]}><AppRoutes /></MemoryRouter>` and assert what `/`
actually resolves to — which is the whole point of this change.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/pages/LandingPage.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LandingPage from "./LandingPage";
import { AppRoutes } from "../App";

afterEach(cleanup);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  );
}

describe("LandingPage", () => {
  it("renders its headline", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    expect(screen.getAllByRole("heading", { level: 1 }).length).toBe(1);
  });

  it("points every call to action at the dashboard login", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const ctas = screen.getAllByRole("link", { name: /mulai/i });
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) {
      expect(cta.getAttribute("href")).toBe("/dashboard/login");
    }
  });

  // THE REGRESSION THIS CHANGE EXISTS TO PREVENT. Before it, "/" matched no
  // route, fell through the catch-all, and redirected to /c/tidak-ada — the
  // bare domain told every visitor a specific community was missing when none
  // had been named.
  it("serves / from the landing page and does not redirect", () => {
    renderAt("/");
    expect(screen.getAllByRole("heading", { level: 1 }).length).toBe(1);
    expect(document.body.textContent).not.toContain("tidak ditemukan");
  });

  it("never says WhatsApp groups are gated — WhatsApp is notification-only", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const text = document.body.textContent ?? "";
    expect(/whatsapp/i.test(text)).toBe(true);
    // The forbidden claim, in the shapes it would plausibly take.
    expect(/grup whatsapp otomatis/i.test(text)).toBe(false);
    expect(/akses grup whatsapp/i.test(text)).toBe(false);
  });

  // The page renders only static copy, so this is true by construction today.
  // The assertion exists so it stays true if anyone later renders anything
  // dynamic here — the spec forbids dangerouslySetInnerHTML on this page.
  it("uses no dangerouslySetInnerHTML", async () => {
    const source = await Bun.file(
      new URL("./LandingPage.tsx", import.meta.url).pathname
    ).text();
    expect(source.includes("dangerouslySetInnerHTML")).toBe(false);
  });

  it("quotes no price, because the platform fee has never been decided", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const text = document.body.textContent ?? "";
    expect(/rp\s?\d/i.test(text)).toBe(false);
    expect(/\d+\s?%/.test(text)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd apps/web && bun test src/pages/LandingPage.test.tsx
```

Expected: FAIL — `LandingPage` and `AppRoutes` do not exist.

- [ ] **Step 3: Extract `AppRoutes` in `apps/web/src/App.tsx`**

Keep every existing route and every existing comment exactly as it is. Change only the wrapper:

```tsx
export function AppRoutes() {
  return (
    <Routes>
      {/* ...every route currently inside <Routes>, unchanged... */}
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
```

Then add the landing route as the **first** route inside `<Routes>`:

```tsx
<Route path="/" element={<LandingPage />} />
```

and import it: `import LandingPage from "./pages/LandingPage";`

- [ ] **Step 4: Write `apps/web/src/pages/LandingPage.tsx`**

Stateless, no fetch, no props. Use `Link` from `react-router-dom` for the calls to action so they
route client-side. Structure and copy:

```tsx
import { Link } from "react-router-dom";

export default function LandingPage() {
  return (
    <main className="landing">
      <section className="landing-hero">
        <p className="landing-eyebrow">DIUDARA</p>
        <h1>Ubah grup Anda jadi komunitas berbayar</h1>
        <p className="landing-lede">
          DIUDARA menangani pembayaran, akses anggota, dan perpanjangan otomatis untuk grup
          Telegram dan WhatsApp yang sudah Anda kelola. Anda tetap fokus ke konten.
        </p>
        <Link className="landing-cta" to="/dashboard/login">
          Mulai sekarang
        </Link>
      </section>

      <section className="landing-section">
        <h2>Mengelola komunitas berbayar itu melelahkan</h2>
        <ul className="landing-list">
          <li>Mengecek transfer masuk satu per satu.</li>
          <li>Menambahkan anggota baru secara manual, setiap hari.</li>
          <li>Tidak tahu siapa yang berhenti membayar — dan tidak sempat mengeluarkannya.</li>
        </ul>
      </section>

      <section className="landing-section">
        <h2>Tiga langkah</h2>
        <ol className="landing-steps">
          <li>
            <strong>Buat komunitas dan paket.</strong> Tentukan nama, harga, dan siklus penagihan.
          </li>
          <li>
            <strong>Bagikan tautan checkout.</strong> Setiap komunitas punya halaman pembayaran
            sendiri.
          </li>
          <li>
            <strong>Anggota bayar, akses diberikan otomatis.</strong> Undangan Telegram sekali
            pakai dikirim begitu pembayaran masuk.
          </li>
        </ol>
      </section>

      <section className="landing-section">
        <h2>Yang Anda dapat</h2>
        <div className="landing-features">
          <article className="landing-feature">
            <h3>Pembayaran QRIS &amp; e-wallet</h3>
            <p>
              Lewat Xendit. Dana anggota masuk ke sub-akun Anda sendiri, bukan ke rekening kami.
            </p>
          </article>
          <article className="landing-feature">
            <h3>Akses Telegram otomatis</h3>
            <p>
              Undangan sekali pakai yang kedaluwarsa, dan pencabutan akses saat berhenti berlangganan.
              WhatsApp dipakai untuk mengirim notifikasi ke anggota.
            </p>
          </article>
          <article className="landing-feature">
            <h3>Perpanjangan otomatis</h3>
            <p>
              Pengingat sebelum dan sesudah jatuh tempo, lalu pencabutan akses otomatis bila tidak
              diperpanjang.
            </p>
          </article>
          <article className="landing-feature">
            <h3>Dashboard dan analitik</h3>
            <p>Jumlah anggota, pendapatan, churn, dan riwayat aktivitas komunitas Anda.</p>
          </article>
          <article className="landing-feature">
            <h3>AI co-builder</h3>
            <p>
              Ceritakan komunitas Anda dalam Bahasa Indonesia, dan AI menyiapkan draf paket serta
              pesan sambutan yang tinggal Anda sunting.
            </p>
          </article>
        </div>
      </section>

      <section className="landing-closing">
        <h2>Siap mencoba?</h2>
        <Link className="landing-cta" to="/dashboard/login">
          Mulai sekarang
        </Link>
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Append styles to `apps/web/src/styles.css`**

Mobile-first: single column by default, widening at 720px. Reuse the file's existing custom
properties if it defines any; otherwise match its literal colours.

```css
/* ---------------------------------------------------------------
   Landing page (/). Prefixed .landing- so these cannot collide with
   the dashboard's rules — this file is one unscoped 700+ line sheet,
   a known carry-forward, and this addition stays self-contained for
   whoever splits it.
   Mobile-first, unlike the dashboard: this is the page a creator
   opens from a link on their phone.
   --------------------------------------------------------------- */
.landing {
  max-width: 44rem;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
}

.landing-eyebrow {
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 0.8rem;
  margin: 0 0 0.5rem;
}

.landing-hero h1 {
  font-size: 2rem;
  line-height: 1.2;
  margin: 0 0 0.75rem;
}

.landing-lede {
  font-size: 1.05rem;
  line-height: 1.6;
  margin: 0 0 1.5rem;
}

.landing-cta {
  display: inline-block;
  padding: 0.85rem 1.5rem;
  border-radius: 0.5rem;
  font-weight: 600;
  text-decoration: none;
}

.landing-section,
.landing-closing {
  margin-top: 3rem;
}

.landing-section h2,
.landing-closing h2 {
  font-size: 1.35rem;
  margin: 0 0 1rem;
}

.landing-list,
.landing-steps {
  margin: 0;
  padding-left: 1.25rem;
  line-height: 1.7;
}

.landing-steps li + li {
  margin-top: 0.75rem;
}

.landing-features {
  display: grid;
  gap: 1rem;
}

.landing-feature h3 {
  font-size: 1rem;
  margin: 0 0 0.35rem;
}

.landing-feature p {
  margin: 0;
  line-height: 1.6;
}

@media (min-width: 720px) {
  .landing {
    padding-top: 4rem;
  }

  .landing-hero h1 {
    font-size: 2.75rem;
  }

  .landing-features {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
```

**Reuse, do not fork, the palette.** `styles.css` already defines custom properties on `:root`
(`--green`, `--green-dark`, `--ink`, `--ink-soft`, `--line`, `--surface`, `--canvas`, `--radius`)
and a `.button-primary` rule (`background: var(--green); color: #fff`, with a `--green-dark`
hover). So:

- The calls to action carry **both** classes: `className="button-primary landing-cta"`.
  `.button-primary` supplies colour and padding; `.landing-cta` only adds what an `<a>` needs that
  a `<button>` does not — `display: inline-block` and `text-decoration: none`. Do not restate the
  colours.
- Each feature carries **both**: `className="card landing-feature"`. `.card` already supplies
  `background: var(--surface)`, `border: 1px solid var(--line)`, `border-radius: var(--radius)`
  and padding.
- Any new colour uses an existing property — `var(--ink-soft)` for the lede and
  `var(--ink-faint)` for the eyebrow. Introduce no new literal hex value.

Adjust the CSS block above accordingly: drop `border-radius`, `padding` and any colour from
`.landing-cta`, and drop the whole `.landing-feature` box treatment, keeping only its `h3` and `p`
rules.

- [ ] **Step 6: Run the tests**

```bash
cd apps/web && bun test src/pages/LandingPage.test.tsx
```

Expected: PASS, 6 tests.

- [ ] **Step 7: Root gates**

```bash
cd ../.. && bun run test && bun run typecheck
```

Expected: 1529 pass / 0 fail (1523 + 6), typecheck exit 0 across four workspaces.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/pages/LandingPage.tsx \
  apps/web/src/pages/LandingPage.test.tsx apps/web/src/styles.css
git commit -m "feat(web): add a landing page at /"
```

---

### Task 2: An honest not-found page

**Files:**
- Create: `apps/web/src/pages/NotFoundPage.tsx`
- Create: `apps/web/src/pages/NotFoundPage.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css` (append)

**Interfaces:**
- Consumes: `AppRoutes` from `apps/web/src/App.tsx` (Task 1).
- Produces: `export default function NotFoundPage()` from `apps/web/src/pages/NotFoundPage.tsx`.

**What is wrong today.** `App.tsx`'s last route is
`<Route path="*" element={<Navigate to="/c/tidak-ada" replace />} />`. Every unknown path is
redirected to the public checkout page for a community whose slug is literally "does not exist", so
the visitor is told a specific community is missing when none was named — and the address bar now
shows a URL they never typed. The dashboard's own catch-all
(`/dashboard/*` → `/dashboard`) is correct and must be left alone.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/pages/NotFoundPage.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";

afterEach(cleanup);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  );
}

describe("an unknown path", () => {
  it("says the page was not found", () => {
    renderAt("/tidak-ada-halaman-ini");
    expect(screen.getAllByText(/halaman tidak ditemukan/i).length).toBe(1);
  });

  // It must RENDER, not redirect: the URL the visitor actually typed has to
  // stay in the address bar, or the message cannot be acted on. Before this,
  // an unknown path was rewritten to /c/tidak-ada — a slug nobody requested.
  it("does not redirect to a fabricated community slug", () => {
    renderAt("/tidak-ada-halaman-ini");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Komunitas tidak ditemukan");
  });

  it("offers a link home", () => {
    renderAt("/tidak-ada-halaman-ini");
    const home = screen.getByRole("link", { name: /beranda/i });
    expect(home.getAttribute("href")).toBe("/");
  });

  // The dashboard keeps its OWN catch-all, which sends an unknown
  // /dashboard/... path to the dashboard home rather than to this page.
  it("leaves the dashboard's own catch-all alone", () => {
    renderAt("/dashboard/tidak-ada");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Halaman tidak ditemukan");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd apps/web && bun test src/pages/NotFoundPage.test.tsx
```

Expected: FAIL — the catch-all still redirects to `/c/tidak-ada`, so the first test finds no
"halaman tidak ditemukan" and the second finds "Komunitas tidak ditemukan".

- [ ] **Step 3: Write `apps/web/src/pages/NotFoundPage.tsx`**

```tsx
import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <main className="landing landing-notfound">
      <h1>Halaman tidak ditemukan</h1>
      <p className="landing-lede">
        Tautan yang Anda buka mungkin salah ketik atau sudah tidak berlaku.
      </p>
      <Link className="landing-cta" to="/">
        Kembali ke beranda
      </Link>
    </main>
  );
}
```

- [ ] **Step 4: Replace the catch-all in `apps/web/src/App.tsx`**

Change the last route inside `<Routes>` from

```tsx
<Route path="*" element={<Navigate to="/c/tidak-ada" replace />} />
```

to

```tsx
{/* Rendered IN PLACE, never redirected: the URL the visitor typed has to stay
    in the address bar or the message cannot be acted on. This used to send
    every unknown path to /c/tidak-ada, which reported that a specific
    community was missing when none had been named. */}
<Route path="*" element={<NotFoundPage />} />
```

and import it: `import NotFoundPage from "./pages/NotFoundPage";`

If `Navigate` is now unused in the file, remove it from the `react-router-dom` import — the
dashboard's own catch-all still uses it, so check before deleting.

- [ ] **Step 5: Append the one style rule to `apps/web/src/styles.css`**

```css
.landing-notfound {
  text-align: center;
  padding-top: 4rem;
}
```

- [ ] **Step 6: Run the tests**

```bash
cd apps/web && bun test src/pages/NotFoundPage.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Root gates**

```bash
cd ../.. && bun run test && bun run typecheck
```

Expected: 1533 pass / 0 fail (1529 + 4), typecheck exit 0 across four workspaces.

- [ ] **Step 8: Check it in a real browser**

Start the API, worker and web app, killing any stale Vite first. Then:

- `http://localhost:5173/` renders the landing page, and the address bar still says `/`.
- `http://localhost:5173/apa-pun` renders "Halaman tidak ditemukan", and the address bar **still
  says `/apa-pun`** — this is the behaviour the tests cannot fully prove, because `MemoryRouter`
  has no address bar.
- Both calls to action reach the login screen.
- The page is readable at a phone width (375px) — resize and check.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/pages/NotFoundPage.tsx \
  apps/web/src/pages/NotFoundPage.test.tsx apps/web/src/styles.css
git commit -m "fix(web): render an honest not-found page instead of redirecting to a fake slug"
```
