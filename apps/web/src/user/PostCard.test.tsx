import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import PostCard from "./PostCard";
import type { PostView } from "./apiClient";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const POST: PostView = {
  id: "post-1",
  body: "Halo semua!\nIni baris kedua.",
  createdAt: new Date(NOW.getTime() - HOUR).toISOString(),
  editedAt: null,
  media: [],
  author: { handle: "wildan", displayName: "Wildan" },
  membersOnly: false,
  lockedMediaCount: 0,
};

function renderCard(props: Partial<Parameters<typeof PostCard>[0]> = {}) {
  return render(
    <MemoryRouter>
      <PostCard post={POST} isOwn={false} now={NOW} {...props} />
    </MemoryRouter>
  );
}

/**
 * Renders the card beside a probe that prints the router's current path, so a
 * test can see whether a click NAVIGATED.
 *
 * Needed because the obvious assertion is a decoration: `fireEvent.click`
 * returns false only when the NATIVE event was cancelled, and React's synthetic
 * `preventDefault` does not cancel it. Measured — a mutation deleting
 * `event.preventDefault()` from PostCard left that assertion green. The router's
 * own location is the only thing here that actually changes when navigation
 * happens.
 */
function renderCardWithLocation(props: Partial<Parameters<typeof PostCard>[0]> = {}) {
  function Where() {
    return <span data-testid="where">{useLocation().pathname}</span>;
  }
  // STARTS SOMEWHERE ELSE, on purpose. The CTA's href is the author's profile,
  // and in production the offer is present precisely when you are ALREADY on
  // that profile — so an un-prevented navigation goes from /@rina to /@rina and
  // changes no observable state at all. Starting at /beranda separates the two
  // so a failure to intercept is visible. It exercises the same branch: the
  // handler asks only whether #membership-offer is in the document.
  return render(
    <MemoryRouter initialEntries={["/beranda"]}>
      <PostCard post={POST} isOwn={false} now={NOW} {...props} />
      <Where />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
});

describe("PostCard", () => {
  it("renders the author's display name, @handle and body", () => {
    renderCard();

    expect(screen.getByText("Wildan")).toBeTruthy();
    expect(screen.getByText("@wildan")).toBeTruthy();
    expect(screen.getByText((_, node) => node?.textContent === "Halo semua!\nIni baris kedua.")).toBeTruthy();
  });

  it("links the handle to /@handle", () => {
    renderCard();

    const links = screen.getAllByRole("link");
    const identityLink = links.find((link) => link.getAttribute("href") === "/@wildan");
    expect(identityLink !== undefined).toBe(true);
  });

  it('shows no "· diedit" marker when editedAt is null', () => {
    renderCard({ post: { ...POST, editedAt: null } });

    expect(screen.queryAllByText(/diedit/).length).toBe(0);
  });

  it('shows "· diedit" when editedAt is set', () => {
    renderCard({ post: { ...POST, editedAt: NOW.toISOString() } });

    expect(screen.queryAllByText(/diedit/).length).toBeGreaterThan(0);
  });

  it("renders the relative time from the injected clock, not a live one", () => {
    renderCard();

    // POST.createdAt is exactly one hour before the injected `now`.
    expect(screen.getByText(/1j/)).toBeTruthy();
  });

  it("renders neither an Edit nor a Hapus control when isOwn is false", () => {
    renderCard({ isOwn: false });

    expect(screen.queryAllByRole("button", { name: "Edit" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Hapus" }).length).toBe(0);
  });

  it("renders both an Edit and a Hapus control when isOwn is true", () => {
    renderCard({ isOwn: true });

    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hapus" })).toBeTruthy();
  });

  it("calls onEdit with the post when Edit is clicked", () => {
    const onEdit = mock(() => {});
    renderCard({ isOwn: true, onEdit });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(POST);
  });

  it("calls onDeleteRequested with the post's id (not the post) when Hapus is clicked", () => {
    const onDeleteRequested = mock(() => {});
    renderCard({ isOwn: true, onDeleteRequested });

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));

    expect(onDeleteRequested).toHaveBeenCalledTimes(1);
    expect(onDeleteRequested).toHaveBeenCalledWith(POST.id);
  });

  it("renders no follow button at all, regardless of isOwn", () => {
    renderCard({ isOwn: false });
    expect(screen.queryAllByRole("button", { name: "Ikuti" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Mengikuti" }).length).toBe(0);

    cleanup();
    renderCard({ isOwn: true });
    expect(screen.queryAllByRole("button", { name: "Ikuti" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Mengikuti" }).length).toBe(0);
  });
});

/**
 * One media entry as the wire sends it — `{ id, width, height }`, mirroring
 * `MediaView` in `apiClient.ts` exactly (no URL: the card derives the
 * thumbnail path itself, from the id).
 */
function mediaEntry(id: string, width: number, height: number) {
  return { id, width, height };
}

/**
 * **No `<img>` node ever reaches an assertion in this file.** Every image
 * below has `alt=""` (spec §12 — no alt text in this phase), which gives it
 * the implicit ARIA role "presentation" and drops it OUT of the "img" role,
 * so `screen.getByRole("img")` cannot even find it. The only correct way to
 * inspect these images is `container.querySelectorAll("img")`, and even then
 * only ATTRIBUTES read off the nodes — via `.getAttribute(...)` — ever reach
 * `expect()`. A bare element handed to a failing matcher hangs the runner:
 * see `no-hanging-dom-assertions.test.ts` and `BerandaPage.test.tsx`'s
 * `isNode`.
 */
describe("PostCard — the media slot (Task 9, spec §3, §4, §5.1, §12)", () => {
  it("renders no media block at all when the post has no images", () => {
    const { container } = renderCard({ post: { ...POST, media: [] } });

    expect(container.querySelectorAll("img").length).toBe(0);
    expect(container.querySelectorAll(".post-card-media").length).toBe(0);
  });

  /**
   * **Fix round 1, Important.** `deploy.sh` copies the new web bundle into
   * nginx's serving directory BEFORE it reloads the api process, and
   * `apiFetch` does no runtime shape validation (`res.json() as T`). For the
   * several seconds that window is open, this bundle — which reads
   * `post.media` on every render — can be talking to the STILL-RUNNING old
   * api, whose response has no `media` field at all (it predates Task 7).
   * `PostView.media`'s own docstring says the field is required and never
   * absent, which is true of a healthy api and false of this window, so the
   * component must survive the response actually being wrong rather than
   * trust the type. There is no error boundary anywhere in this app: a throw
   * here during that window is not "a post renders without its photos", it
   * is a blank `/beranda` and a blank profile page for every visitor.
   *
   * The cast is deliberate: this object lies about `PostView` on purpose,
   * the same way the real skewed response does.
   */
  it("renders without throwing when `media` is missing from the response entirely (version-skew deploy window)", () => {
    const skewed = {
      id: POST.id,
      body: POST.body,
      createdAt: POST.createdAt,
      editedAt: POST.editedAt,
      author: POST.author,
    } as unknown as PostView;

    const { container } = renderCard({ post: skewed });

    expect(container.querySelectorAll(".post-card-media").length).toBe(0);
    expect(container.querySelectorAll("img").length).toBe(0);
  });

  it("renders one image from the THUMBNAIL endpoint, never the full-size one", () => {
    const { container } = renderCard({
      post: { ...POST, media: [mediaEntry("m1", 800, 600)] },
    });

    const srcs = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(srcs).toEqual(["/users/media/m1/thumb"]);
  });

  it("renders three images, one per media entry, in the given order", () => {
    const { container } = renderCard({
      post: {
        ...POST,
        media: [mediaEntry("m1", 800, 600), mediaEntry("m2", 400, 400), mediaEntry("m3", 200, 900)],
      },
    });

    const srcs = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(srcs).toEqual(["/users/media/m1/thumb", "/users/media/m2/thumb", "/users/media/m3/thumb"]);
  });

  it("renders five images, one per media entry, in the given order", () => {
    const { container } = renderCard({
      post: {
        ...POST,
        media: [
          mediaEntry("m1", 800, 600),
          mediaEntry("m2", 400, 400),
          mediaEntry("m3", 200, 900),
          mediaEntry("m4", 1000, 500),
          mediaEntry("m5", 300, 300),
        ],
      },
    });

    const srcs = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(srcs).toEqual([
      "/users/media/m1/thumb",
      "/users/media/m2/thumb",
      "/users/media/m3/thumb",
      "/users/media/m4/thumb",
      "/users/media/m5/thumb",
    ]);
  });

  it("sets width and height attributes from EACH entry's own size — the row reserves its own space, not a shared guess", () => {
    const { container } = renderCard({
      post: {
        ...POST,
        media: [mediaEntry("m1", 800, 600), mediaEntry("m2", 400, 900)],
      },
    });

    const dims = [...container.querySelectorAll("img")].map((img) => [
      img.getAttribute("width"),
      img.getAttribute("height"),
    ]);
    expect(dims).toEqual([
      ["800", "600"],
      ["400", "900"],
    ]);
  });

  it('gives every image alt="" — no alt text in this phase (spec §12), never text borrowed from the body', () => {
    const { container } = renderCard({
      post: {
        ...POST,
        media: [mediaEntry("m1", 800, 600), mediaEntry("m2", 400, 400), mediaEntry("m3", 200, 900)],
      },
    });

    const alts = [...container.querySelectorAll("img")].map((img) => img.getAttribute("alt"));
    expect(alts).toEqual(["", "", ""]);
  });

  it("marks the media wrapper with how many images it holds, as a styling hook for the 1/3/5 layouts", () => {
    const { container } = renderCard({
      post: {
        ...POST,
        media: [mediaEntry("m1", 800, 600), mediaEntry("m2", 400, 400), mediaEntry("m3", 200, 900)],
      },
    });

    const wrapper = container.querySelector(".post-card-media");
    expect(wrapper?.getAttribute("data-count")).toBe("3");
  });

  it("places the media slot between the body and the owner actions, as the brief specifies", () => {
    const { container } = renderCard({
      isOwn: true,
      post: { ...POST, media: [mediaEntry("m1", 800, 600)] },
    });

    const html = container.innerHTML;
    const bodyIndex = html.indexOf("Halo semua!");
    const mediaIndex = html.indexOf("/users/media/m1/thumb");
    const actionsIndex = html.indexOf(">Edit<");

    expect(bodyIndex).toBeGreaterThan(-1);
    expect(mediaIndex).toBeGreaterThan(bodyIndex);
    expect(actionsIndex).toBeGreaterThan(mediaIndex);
  });
});

/**
 * Same technique as `no-raw-server-errors.test.ts`'s `stripComments`: a
 * literal scan for a string this file's OWN documentation is expected to
 * discuss (this docstring explains why the field is absent, which means it
 * has to name it) would flag its own prose. Comments are stripped first so
 * only actual code is scanned.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Phase 2's carry-forward names this card as exactly where `viewerFollows`
 * gets guessed back into existence (`signedIn ? false : null`) once a follow
 * affordance is tempting to add here. `PostCard`'s props take no such field
 * at all — copies `FollowButton.test.tsx`'s own N4 technique of scanning the
 * real source file rather than trusting the type system, since a stray prop
 * added without a corresponding usage would still typecheck.
 */
describe("PostCard — no viewerFollows anywhere in this component (carry-forward)", () => {
  it("the source file's CODE never mentions viewerFollows", () => {
    const source = readFileSync(join(import.meta.dir, "PostCard.tsx"), "utf8");
    expect(stripComments(source).includes("viewerFollows")).toBe(false);
  });

  it("detects the pattern when it IS present in code — guards the guard", () => {
    const withUsage = "const x = 1;\nconst viewerFollows = false;\n";
    expect(stripComments(withUsage).includes("viewerFollows")).toBe(true);
  });

  it("does NOT flag the word when it appears only in a comment", () => {
    const documented = "// This component takes no viewerFollows prop.\nconst x = 1;\n";
    expect(stripComments(documented).includes("viewerFollows")).toBe(false);
  });

  it("the source file's CODE never renders the body via dangerouslySetInnerHTML", () => {
    const source = readFileSync(join(import.meta.dir, "PostCard.tsx"), "utf8");
    expect(stripComments(source).includes("dangerouslySetInnerHTML")).toBe(false);
  });
});

/**
 * **Task 7 — the lock panel, the conversion surface (spec §5, §5.1; design
 * §8).** A locked post is told apart from an ordinary one ONLY by
 * `lockedMediaCount > 0` — never by `membersOnly` alone, since `membersOnly`
 * is `true` on every members-only post including the ones the viewer CAN see
 * (the author's own, and a paying member's), and never by `media.length ===
 * 0` alone, since an ordinary post with no photos is also `[]`.
 * `lockedMediaCount` is the one field the API sets to exactly "there is
 * something here you cannot see" (its own docstring in `apiClient.ts`).
 *
 * `document.body.innerHTML` — not a scoped `container.innerHTML` — is used
 * for the URL-leak test on purpose: the whole DOM is the surface a browser
 * could serve to a non-member, not just this component's own subtree.
 */
describe("PostCard — the lock panel (Task 7, spec §5, §5.1)", () => {
  const lockedPost: PostView = {
    ...POST,
    body: "Behind the scenes",
    media: [],
    membersOnly: true,
    lockedMediaCount: 3,
    author: { handle: "rina", displayName: "Rina" },
  };

  it("a locked post shows the caption, the count, and the invitation", () => {
    renderCard({ post: lockedPost });

    const text = screen.getByTestId("post-card").textContent ?? "";
    expect(text).toContain("Behind the scenes");
    expect(text).toContain("3 foto terkunci");
    expect(text).toContain("Jadi anggota untuk melihat");
  });

  /**
   * Fix round 1 (Major, coordinator review): the previous version of this
   * file pinned the caption, the count and the invitation with `toContain`
   * ONLY — a substring check that stays green when text is APPENDED to any
   * of the three (verified: mutating the count copy to
   * `"3 foto terkunci ekstra"` left all 30 tests green before this fix).
   * `1d8d133` already fixed exactly this shape for the invitation link's
   * accessible name; these two tests give the other two strings the same
   * standard of proof — exact `.textContent`, not `toContain`.
   */
  it("the locked count copy is EXACT, not merely present — catches text appended after it", () => {
    const { container } = renderCard({ post: lockedPost });

    const count = container.querySelector(".post-card-locked-count");
    expect(count?.textContent ?? "").toBe("3 foto terkunci");
  });

  /**
   * The property parent spec §5 actually cares about: "its caption
   * readable" is why a visible lock converts at all. Scoped to the
   * `.post-card-body` node's own `.textContent`, not the whole card's, so it
   * cannot be satisfied by the count or the invitation text instead.
   */
  it("the locked post's caption survives into the locked view, EXACT and unmodified", () => {
    const { container } = renderCard({ post: lockedPost });

    const body = container.querySelector(".post-card-body");
    expect(body?.textContent ?? "").toBe("Behind the scenes");
  });

  /**
   * The link target is the author's PUBLIC profile route, `/@handle` — the
   * SAME shape every other in-app link to a profile already uses (the
   * identity link above, `FollowListPage`, `JelajahPage`), and the ONLY shape
   * `ProfilePage`'s own route actually accepts: `App.tsx` mounts the profile
   * at the bare `path="/:handleParam"` and `ProfilePage` 404s anything whose
   * first segment does not start with "@" (see that file's docstring). A
   * bare "/rina" would 404, not open the offer.
   */
  it("the lock links to the author's profile, where the offer lives", () => {
    renderCard({ post: lockedPost });

    // A plain string TextMatch (not a regex) matches the accessible name
    // EXACTLY, not as a substring — chosen over a regex on purpose, so a
    // mutant that appends to "Jadi anggota untuk melihat" (e.g. "... foto")
    // fails to resolve the link at all instead of silently matching.
    expect(
      screen.getByRole("link", { name: "Jadi anggota untuk melihat" }).getAttribute("href")
    ).toBe("/@rina");
  });

  it("an unlocked members-only post renders its images, not the lock", () => {
    const unlockedMembersOnly: PostView = {
      ...POST,
      membersOnly: true,
      lockedMediaCount: 0,
      media: [mediaEntry("m1", 800, 600)],
    };

    const { container } = renderCard({ post: unlockedMembersOnly });

    const srcs = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(srcs).toEqual(["/users/media/m1/thumb"]);
    expect(screen.queryAllByText(/terkunci/).length).toBe(0);
    expect(screen.queryAllByText("Jadi anggota untuk melihat").length).toBe(0);
  });

  it("no image URL for a locked post reaches the DOM", () => {
    renderCard({ post: lockedPost });

    expect(document.body.innerHTML).not.toContain("/users/media/");
  });

  /**
   * EXACT, like the plural case above. Whole-branch review, MIN-5: this was the
   * last residual `toContain` on new copy — a superstring satisfies it, so a
   * mutant rendering `"1 foto terkunci saja"` passed, and the plural test's
   * exact assertion does not reach the singular branch.
   */
  it("renders the singular count the same way — Indonesian 'foto' does not inflect for number", () => {
    const { container } = renderCard({ post: { ...lockedPost, lockedMediaCount: 1 } });

    const count = container.querySelector(".post-card-locked-count");
    expect(count?.textContent ?? "").toBe("1 foto terkunci");
  });

  it("renders no media block at all for a locked post", () => {
    const { container } = renderCard({ post: lockedPost });

    expect(container.querySelectorAll(".post-card-media").length).toBe(0);
    expect(container.querySelectorAll("img").length).toBe(0);
  });

  it("every post-card root carries data-testid=post-card, locked or not", () => {
    renderCard({ post: POST });
    expect(screen.getByTestId("post-card").textContent ?? "").toContain("Halo semua!");
  });
});

/**
 * **Task 8 — the bug the user actually reported.** `<Link to="/@handle">` on
 * the author's OWN profile is a link to the page already on screen: clicking
 * it does nothing at all, silently. `PostCard` cannot know by itself whether
 * it is being rendered on that profile — it only knows the author's handle,
 * never the current route — so the fix does not ask "is this the author's
 * profile", it asks "is the offer this CTA is promising ALREADY on this
 * page", by checking for `document.getElementById("membership-offer")`
 * (`ProfilePage` gives `MembershipOffer`'s section that id). That is `true`
 * on exactly the page where the old link was a no-op, and `false` on the
 * feed (Beranda), where the old link still does something real.
 *
 * `document.body.innerHTML` is used directly to plant and remove the stand-in
 * offer element — `renderCard`'s own `<MemoryRouter>` wraps only the card, and
 * `MembershipOffer` genuinely lives OUTSIDE that subtree on a real profile
 * page, so the fixture has to plant its id on `document.body` the same way.
 * Removed again in `afterEach` so it cannot leak into a later test in this
 * file — `cleanup()` unmounts React trees, not elements appended by hand.
 */
describe("PostCard — the lock CTA goes somewhere real (Task 8, the reported bug)", () => {
  const lockedPost: PostView = {
    ...POST,
    body: "Behind the scenes",
    media: [],
    membersOnly: true,
    lockedMediaCount: 1,
    author: { handle: "rina", displayName: "Rina" },
  };

  afterEach(() => {
    document.getElementById("membership-offer")?.remove();
  });

  /**
   * A click handler existing proves nothing by itself — a handler that
   * scrolled the wrong element, or nothing, would still "have an onClick".
   * This asserts the ACTUAL DOM call the fix depends on: `scrollIntoView`
   * fired, on the specific node whose id the CTA is supposed to find.
   */
  it("scrolls to the offer, by calling scrollIntoView on the actual #membership-offer node, when the offer is present on this page", () => {
    const scrolled: string[] = [];
    const offer = document.createElement("div");
    offer.id = "membership-offer";
    offer.scrollIntoView = () => scrolled.push("membership-offer");
    document.body.appendChild(offer);

    renderCardWithLocation({ post: lockedPost });
    const cta = screen.getByRole("link", { name: "Jadi anggota untuk melihat" });
    fireEvent.click(cta);

    expect(scrolled).toEqual(["membership-offer"]);
    // AND IT DID NOT NAVIGATE — asserted on the router's own location, which is
    // the only thing in this harness that actually moves. Mutation-verified:
    // deleting `event.preventDefault()` from PostCard reddens this line.
    // The obvious version (`expect(fireEvent.click(cta)).toBe(false)`) does NOT
    // redden under that mutation, because React's synthetic preventDefault
    // leaves the native event uncancelled. It was tried first and thrown away.
    expect(screen.getByTestId("where").textContent).toBe("/beranda");
    // It stays a real link on purpose — middle-click, copy-link and
    // open-in-new-tab keep working, and on the feed navigating IS correct.
    // What makes it "go somewhere real" is not the element type but the
    // prevented default asserted above: the href is still the profile, and
    // that is the right destination from anywhere except the profile itself.
    expect(cta.getAttribute("href")).toBe("/@rina");
  });

  /**
   * Presence control, and the case `PostFeed` actually exercises on Beranda:
   * no `#membership-offer` anywhere in the document (a feed never renders
   * `MembershipOffer` at all), so the CTA keeps being a real link to the
   * author's profile — where the offer genuinely does live.
   */
  it("still links to the author's profile when the offer is not present on this page", () => {
    renderCard({ post: lockedPost });

    const cta = screen.getByRole("link", { name: "Jadi anggota untuk melihat" });
    expect(cta.getAttribute("href")).toBe("/@rina");
    expect(screen.queryAllByRole("button", { name: "Jadi anggota untuk melihat" }).length).toBe(0);
  });
});

/**
 * **Task 8 — the community feed's additions to `PostCard` (spec §"One card, not
 * two"):** an optional `detailHref`, a `Pengumuman` badge read from `post.type`,
 * and a comment-count link. All three additive: a personal post passes none of
 * them and renders exactly as before.
 *
 * Negative assertions use `queryAllBy…().length`, never
 * `queryBy…().toBeNull()` — the brief's own snippet used `.toBeNull()`, which
 * `no-hanging-dom-assertions.test.ts` flags (a failing serialising matcher on a
 * happy-dom node exhausts RAM). Same intent, safe form.
 */
function aPost(overrides: Partial<PostView> = {}): PostView {
  return { ...POST, ...overrides };
}

describe("PostCard — the community feed additions (Task 8)", () => {
  it("a pengumuman card is labelled as one", () => {
    renderCard({ post: aPost({ type: "pengumuman" }) });
    expect(screen.getByText("Pengumuman")).toBeTruthy();
  });

  it("a diskusi card carries no type label", () => {
    renderCard({ post: aPost({ type: "diskusi" }) });
    expect(screen.queryAllByText("Pengumuman").length).toBe(0);
  });

  it("the comment count links to the discussion", () => {
    renderCard({
      post: aPost({ commentCount: 3 }),
      detailHref: "/komunitas/kelas-fisika/diskusi/p1",
    });
    const link = screen.getByRole("link", { name: /3 komentar/ });
    // A STRING, never the node: a failing assertion holding a happy-dom
    // element serialises the whole tree and exhausts memory.
    expect(link.getAttribute("href")).toBe("/komunitas/kelas-fisika/diskusi/p1");
  });

  it("with no detailHref there is no comment link at all", () => {
    renderCard({ post: aPost({ commentCount: 3 }) });
    expect(screen.queryAllByRole("link", { name: /komentar/ }).length).toBe(0);
  });
});

/** 15 September 2026, 16:00 WIB — and 18:00 WIB. */
const STARTS_AT = "2026-09-15T09:00:00.000Z";
const ENDS_AT = "2026-09-15T11:00:00.000Z";

const AN_EVENT = { title: "Trigonometri lanjutan", startsAt: STARTS_AT, endsAt: null, location: null };

describe("PostCard — a kegiatan (Phase 3)", () => {
  it("shows the badge, the title and the WIB date and time", () => {
    renderCard({ post: aPost({ type: "kegiatan", event: AN_EVENT }) });

    expect(screen.getByText("Kegiatan")).toBeTruthy();
    expect(screen.getByText("Trigonometri lanjutan")).toBeTruthy();
    expect(screen.getByText(/15 September 2026/)).toBeTruthy();
    // WIB, not UTC: 09:00Z is 16.00 in Jakarta. A card rendering "09.00"
    // here is one reading the instant's UTC fields.
    expect(screen.getByText(/16\.00 WIB/)).toBeTruthy();
  });

  it("shows an end time only when the event has one", () => {
    const { unmount } = renderCard({
      post: aPost({ type: "kegiatan", event: { ...AN_EVENT, endsAt: ENDS_AT } }),
    });
    expect(screen.getByText(/16\.00 WIB–18\.00 WIB/)).toBeTruthy();
    unmount();

    renderCard({ post: aPost({ type: "kegiatan", event: AN_EVENT }) });
    expect(screen.queryAllByText(/–/).length).toBe(0);
  });

  it("shows a location only when the event has one", () => {
    const { unmount } = renderCard({
      post: aPost({ type: "kegiatan", event: { ...AN_EVENT, location: "Online via Zoom" } }),
    });
    expect(screen.getByText("Online via Zoom")).toBeTruthy();
    unmount();

    renderCard({ post: aPost({ type: "kegiatan", event: AN_EVENT }) });
    expect(screen.queryAllByText("Online via Zoom").length).toBe(0);
  });

  /**
   * The case that covers every other surface in the app — Beranda, profiles,
   * and every community discussion. Nothing about them may change.
   */
  it("a post with no event renders no event meta and no badge", () => {
    renderCard({ post: aPost({ type: "diskusi" }) });

    expect(screen.queryAllByText("Kegiatan").length).toBe(0);
    expect(screen.queryAllByTestId("post-card-event").length).toBe(0);
  });

  /**
   * The deploy window `PostView.media`'s docstring describes: a new bundle
   * against an API that has never heard of `event`. A bare `.title` read
   * there is an uncaught render throw with no error boundary in this app.
   */
  it("survives an event field the API never sent", () => {
    renderCard({ post: aPost({ type: "kegiatan" }) });
    expect(screen.queryAllByTestId("post-card-event").length).toBe(0);
  });
});

/**
 * **The judgement call the task brief asked to be made honestly, and the
 * behaviour this file deliberately does NOT test.**
 *
 * The brief's third scenario: a lock CTA should say nothing that promises a
 * membership when the author offers no tier at all. Proving that needs a
 * field `PostView.author` does not carry — there is no
 * "does this author sell any membership" signal on a post at all, and
 * `PostCard` has no network access to ask for one. Building it means
 * widening `apps/api`'s author projection (`post-views.ts`'s `PostView`) and
 * its own closed-shape assertion (`Object.keys(view.author).sort()` in
 * `post-views.test.ts`), which every one of the six prior tasks in this
 * phase deliberately left shut — and Task 8's own brief says, at the top,
 * "WEB ONLY".
 *
 * So this task took the brief's own honest fallback: the test AND the
 * behaviour were dropped together, not just the test. `PostCard`'s lock CTA
 * still says only what `PostView` can already prove — "this post is
 * gated" — and never claims there is a membership to buy; it just no longer
 * tries to prove the STRONGER claim ("...and this author is selling one")
 * that would need the API to widen. See `PostCard.tsx`'s own comment beside
 * the CTA for the identical reasoning at the point a future reader will
 * actually meet it.
 */
