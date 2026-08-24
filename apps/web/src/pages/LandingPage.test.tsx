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

  /**
   * Retire-telegram Task 1, fix round 1 (review Critical 1). Both
   * "Mulai sekarang" buttons used to point at `/dashboard/login`, which
   * Task 1 itself deleted — leaving the app's two most prominent controls
   * 404ing while a since-removed version of THIS test certified the dead
   * target. They now point at `/signup`, the same place the small `Daftar`
   * link below goes: with the dashboard gone, that is the new world's only
   * real entry point. Named and literal so a regression back to
   * `/dashboard/login` (or any other dead route) fails here, not silently
   * in production.
   */
  it("points every call to action at /signup, not the deleted dashboard login", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const ctas = screen.getAllByRole("link", { name: /mulai/i });
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) {
      expect(cta.getAttribute("href")).toBe("/signup");
    }
  });

  // Task 5: the personal-account entry points. Fix round 1: the big
  // "Mulai sekarang" CTAs above now point at the same /signup destination
  // as this small `Daftar` link, so this test only pins the small entry
  // points' own hrefs — the CTA target itself is pinned by the test above.
  it("also links to /signup and /masuk via the small entry-point links", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const signup = screen.getByRole("link", { name: "Daftar" });
    expect(signup.getAttribute("href")).toBe("/signup");
    const login = screen.getByRole("link", { name: "Masuk" });
    expect(login.getAttribute("href")).toBe("/masuk");
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

  // Tests the RULE, not two spellings: no sentence that mentions WhatsApp may
  // also talk about access, joining, or invites. A prior version of this test
  // only forbade the two literal phrases "grup whatsapp otomatis" and "akses
  // grup whatsapp" — it missed "akses anggota ... untuk grup Telegram dan
  // WhatsApp", which reads as WhatsApp access being automated when it is not:
  // Meta's API has no add-participant endpoint and caps groups at 8 members.
  // Sentences are read per <p>/<li> (not the whole page as one blob) so two
  // unrelated sentences in different elements are never spuriously merged.
  it("never puts access, joining, or invite language in the same sentence as WhatsApp", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const blocks = Array.from(document.querySelectorAll("p, li, h1, h2, h3"));
    const sentences = blocks.flatMap((block) => (block.textContent ?? "").split(/(?<=[.!?])\s+/));
    const mentionsWhatsapp = sentences.filter((s) => /whatsapp/i.test(s));
    // WhatsApp must still appear somewhere — the page cannot pass by omitting it.
    expect(mentionsWhatsapp.length).toBeGreaterThan(0);
    // Nouns (akses/gabung/undangan) alone miss the plainest Indonesian phrasing,
    // which is verbal: "masuk ke" (getting into the group), "tambahkan"/"keluarkan"
    // (added/removed — also matches the "di-...-kan" passive forms "ditambahkan"/
    // "dikeluarkan" as substrings).
    const gatedSounding = mentionsWhatsapp.filter((s) =>
      /akses|gabung|undangan|masuk ke|tambahkan|keluarkan/i.test(s)
    );
    expect(gatedSounding.length).toBe(0);
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


  /**
   * MAJ-7's REGRESSION GUARD, AND THE ONE THIS PAGE MOST NEEDED.
   *
   * Before Phase 8's final fix wave, step two of "Tiga langkah" told a visitor
   * to *"Bagikan tautan checkout — setiap komunitas punya halaman pembayaran
   * sendiri"*, naming `/c/:slug/checkout`. Task 4 had deleted that route four
   * tasks earlier. Nothing failed: the CTA tests below pin the two links whose
   * `href` they already know, and prose that merely *describes* a dead route is
   * invisible to them.
   *
   * So this does not compare hrefs against a hand-kept list — a list is exactly
   * what went stale. It renders every link on the page through the REAL
   * `AppRoutes` and fails if any of them lands on the 404 page. A route deleted
   * in some future phase turns its landing-page link red here, in this file,
   * instead of in a visitor's browser.
   *
   * The positive control is not decoration. An "assert nothing 404s" test passes
   * vacuously if the detector is wrong (`textContent` read at the wrong moment,
   * the 404 copy reworded, `renderAt` silently rendering nothing), and it would
   * then certify a page of dead links. The control drives the two shapes that
   * actually shipped here — the deleted checkout link and the deleted dashboard
   * login — through the identical code path and requires them to be CAUGHT.
   */
  it("points every link at a route this app actually serves", () => {
    const notFound = (path: string): boolean => {
      renderAt(path);
      const text = document.body.textContent ?? "";
      cleanup();
      return text.includes("tidak ditemukan");
    };

    // POSITIVE CONTROL, first: two routes this branch really deleted. If the
    // detector cannot see these, the sweep below proves nothing.
    expect(notFound("/c/apa-saja/checkout")).toBe(true);
    expect(notFound("/dashboard/login")).toBe(true);

    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    // Collected as strings and the tree torn down BEFORE anything is asserted:
    // no DOM node is ever on either side of a matcher here.
    const hrefs = Array.from(document.querySelectorAll("a")).map(
      (a) => a.getAttribute("href") ?? ""
    );
    cleanup();
    expect(hrefs.length).toBeGreaterThan(0);

    const dead = hrefs.filter((href) => notFound(href));
    expect(dead.join(", ")).toBe("");
  });

  /**
   * The vocabulary of the world this branch deleted, as a denylist.
   *
   * The link sweep above catches a dead `href`; it cannot catch a feature card
   * headed "Akses Telegram otomatis", "Dashboard dan analitik" or "AI
   * co-builder" — three of the four cards that were selling deleted machinery,
   * none of which contained a link at all. Those are pure prose, and prose is
   * what the last seven phases kept leaving behind.
   *
   * Each entry below names something whose implementation is gone: the Telegram
   * adapter and everything it gated (Task 2), communities and their checkout
   * (Task 4), the creator dashboard and `routes/analytics.ts` (Tasks 1 and 3),
   * `infrastructure/ai/` (Task 3), and the renewal/churn passes (Task 5). If one
   * of these words ever belongs on this page again, the thing it names has to
   * exist again first — and then this list is the deliberate place to say so.
   */
  it("uses none of the deleted world's vocabulary", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const text = document.body.textContent ?? "";
    cleanup();
    // PROOF OF LIFE. A denylist over `textContent` passes vacuously if the page
    // renders nothing, and five sibling tests reddening first is luck, not a
    // guarantee. "DIUDARA" is the eyebrow above the H1 and the one word on this
    // page that is not a product claim, so it is the stable thing to require.
    expect(text).toContain("DIUDARA");
    const banned: Array<[string, RegExp]> = [
      ["telegram", /telegram/i],
      ["komunitas", /komunitas/i],
      // The old H1 was "Ubah GRUP Anda jadi komunitas berbayar". Nothing in the
      // surviving product is a group.
      ["grup", /\bgrup\b/i],
      ["dashboard", /dashboard/i],
      ["analitik", /analitik/i],
      ["checkout", /checkout/i],
      ["undangan", /undangan/i],
      ["churn", /churn/i],
      // Case-SENSITIVE and word-bounded: lowercase "ai" is a substring of
      // ordinary Indonesian ("dipakai", "ramai"), and only the standalone
      // capitalised form ever named the deleted co-builder.
      ["AI", /\bAI\b/],
    ];
    const found = banned.filter(([, pattern]) => pattern.test(text)).map(([word]) => word);
    expect(found.join(", ")).toBe("");
  });

  /**
   * NOTHING IN THIS SYSTEM RENEWS ANYTHING.
   *
   * The Xendit adapter has two operations and no tokenisation, so there is no
   * stored instrument to charge a second time: `StartUserSubscription`'s own
   * docstring states that "renew" means the member presses "Jadi anggota" again,
   * and `RemindExpiringMembership` exists precisely because a membership just
   * ends. The deleted page promised the opposite twice — a whole "Perpanjangan
   * otomatis" card and a "perpanjangan otomatis" clause in the lede — which is
   * the single most expensive thing this page could get wrong: a buyer who
   * believes access continues finds out by losing it.
   *
   * Kept separate from the denylist above because it is a different kind of
   * claim. "Telegram" is a word that must not appear; this is a PROMISE that
   * must not be made, and it can be made without any banned word in it.
   */
  it("never promises that a membership renews itself", () => {
    // "otomatis" is fine on its own — a future line like "aksesnya terbuka
    // otomatis" would be true. What may never be said is that the BILLING or the
    // MEMBERSHIP repeats by itself.
    //
    // NEGATION IS THE WHOLE DIFFICULTY. The page's own honest headline is
    // "Tanpa tagihan berulang", which is the exact phrase a naive pattern flags
    // — and a test that forces that headline off the page would push the copy
    // AWAY from the truth. So a hit is discounted when a negator sits
    // immediately in front of it, and the controls below drive both directions
    // through this same function rather than trusting that reasoning.
    const promisesRenewal = (text: string): string[] => {
      const patterns = [
        /perpanjangan otomatis/gi,
        /(?:diperpanjang|memperpanjang|perpanjang)[^.]{0,30}otomatis/gi,
        /otomatis[^.]{0,30}(?:diperpanjang|perpanjang)/gi,
        /(?:langganan|tagihan|pembayaran|penagihan)[^.]{0,20}(?:berulang|otomatis)/gi,
      ];
      const hits: string[] = [];
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          const before = text.slice(Math.max(0, (match.index ?? 0) - 25), match.index ?? 0);
          if (/\b(?:tanpa|tidak|bukan|tak)\b/i.test(before)) continue;
          hits.push(match[0]);
        }
      }
      return hits;
    };

    // POSITIVE CONTROLS — the two shapes the deleted page actually shipped, and
    // one it did not. All three must be caught, or the page assertion below is
    // certifying nothing.
    expect(promisesRenewal("Perpanjangan otomatis").length).toBeGreaterThan(0);
    expect(
      promisesRenewal("Pengingat sebelum jatuh tempo, lalu langganan diperpanjang otomatis.")
        .length
    ).toBeGreaterThan(0);
    expect(promisesRenewal("Tagihan berulang setiap bulan.").length).toBeGreaterThan(0);
    // NEGATIVE CONTROL — the denial is not a promise.
    expect(promisesRenewal("Tanpa tagihan berulang.").join(", ")).toBe("");

    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const text = document.body.textContent ?? "";
    cleanup();
    expect(promisesRenewal(text).join(", ")).toBe("");
  });

  /**
   * THE PHOTOS LOCK. THE WORDS DO NOT. And the first rewrite said otherwise.
   *
   * Phase 8's re-review found this page claiming *"Tandai sebuah postingan
   * sebagai khusus anggota, dan hanya anggota berbayar Anda yang bisa
   * membukanya"*, and applying *"Tandai yang khusus anggota"* to **tulisan**.
   * Both false, and false about a SURVIVING feature rather than a deleted one —
   * which is why the three guards above all stayed green through it. There is no
   * banned word in a wrong description of a live product, no renewal promise and
   * no link to 404.
   *
   * What the code actually does:
   *
   *   - `toPostView` (`post-views.ts`) returns `body: row.body` UNCONDITIONALLY
   *     and empties only `media`; `PostCard` renders the body OUTSIDE its
   *     `locked ?` branch, and the locked branch shows a count of hidden photos
   *     plus a link to the author's profile.
   *   - `requireImageWhenLocked` (`write-post.ts`) throws
   *     "kiriman khusus anggota harus punya minimal satu foto", so a text-only
   *     post cannot be members-only at all. `PostComposer` disables the checkbox
   *     until an image is attached and says why: *"Tambahkan foto dulu — teks
   *     selalu bisa dibaca semua orang."*
   *
   * That is a deliberate Phase 6 decision — the caption is the teaser that makes
   * the lock convert — so this test pins it as a RULE in two directions rather
   * than as a spelling:
   *
   *   POSITIVE: the page must SAY somewhere that the text stays readable. A page
   *   that simply drops the clause is back to implying a full paywall.
   *
   *   NEGATIVE: any sentence that talks about locking must name what actually
   *   locks — a photo or a stream. A sentence claiming the words lock fails
   *   here even if it uses wording nobody has thought of yet.
   */
  it("says the photos lock and the words stay readable", () => {
    const sentencesOf = (root: ParentNode): string[] =>
      Array.from(root.querySelectorAll("p, li, h1, h2, h3")).flatMap((block) =>
        (block.textContent ?? "").split(/(?<=[.!?])\s+/)
      );
    // A sentence may only talk about locking if it names something that locks.
    // TWO WAYS TO SAY IT, and the second is the one that actually shipped: the
    // false card carried no lock word at all, it claimed EXCLUSIVITY ("hanya
    // anggota berbayar Anda yang bisa membukanya"). A rule that only knew
    // "terkunci" would have passed it, so both spellings of the claim count.
    const LOCK = /terkunci|dikunci|\bkunci\b|tersembunyi|hanya anggota|khusus anggota saja/i;
    const LOCKABLE = /foto|siaran/i;
    const misdescribesLock = (sentences: string[]): string[] =>
      sentences.filter((s) => LOCK.test(s) && !LOCKABLE.test(s));

    // POSITIVE CONTROLS on the negative rule. The first is the exact sentence
    // the re-review caught; the other two are the plainest ways to get it wrong
    // in Indonesian. All three must be flagged, or the sweep over the real page
    // below proves nothing.
    expect(
      misdescribesLock([
        "Tandai sebuah postingan sebagai khusus anggota, dan hanya anggota berbayar Anda yang bisa membukanya.",
      ]).length
    ).toBe(1);
    expect(misdescribesLock(["Tandai tulisan Anda dan teksnya terkunci."]).length).toBe(1);
    expect(misdescribesLock(["Kiriman khusus anggota dikunci seluruhnya."]).length).toBe(1);
    // NEGATIVE CONTROL: the true sentence must NOT be flagged.
    expect(
      misdescribesLock(["Yang terkunci adalah fotonya, bukan teksnya."]).join(" | ")
    ).toBe("");

    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const sentences = sentencesOf(document);
    const text = document.body.textContent ?? "";
    cleanup();

    expect(sentences.length).toBeGreaterThan(0);
    expect(misdescribesLock(sentences).join(" | ")).toBe("");

    // The positive half: the page must state that the words stay open. Written
    // as alternatives rather than one literal so the copy can be reworded, but
    // not so loosely that deleting the promise passes.
    const saysTextIsOpen =
      /(teks|tulisan)[^.;]{0,60}(terbuka untuk semua|bisa dibaca siapa saja|dibaca semua orang|bisa dibaca semua)/i;
    expect(saysTextIsOpen.test(text)).toBe(true);
  });

  it("quotes no price, because the platform fee has never been decided", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const text = document.body.textContent ?? "";
    // [.\s]* rather than \s? — ordinary Indonesian spelling puts a period after
    // "Rp" ("Rp. 0"), which a single optional space never matches.
    expect(/rp[.\s]*\d/i.test(text)).toBe(false);
    // "persen" is the more idiomatic written-out form in this copy's register,
    // and quoting a rate that way is just as much a public commitment as "%".
    expect(/(\d+\s?%|persen)/i.test(text)).toBe(false);
  });
});
