import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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

  it("renders the singular count the same way — Indonesian 'foto' does not inflect for number", () => {
    renderCard({ post: { ...lockedPost, lockedMediaCount: 1 } });

    const text = screen.getByTestId("post-card").textContent ?? "";
    expect(text).toContain("1 foto terkunci");
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
