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
