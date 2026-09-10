import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import CommentList from "./CommentList";
import { setUserSession, type CommentView } from "./apiClient";

const USER = { handle: "rina", displayName: "Rina", email: "rina@example.com" };

function comment(id: string, body: string, handle: string, displayName: string): CommentView {
  return { id, body, createdAt: "2026-09-01T00:00:00.000Z", author: { handle, displayName } };
}

const THREAD: CommentView[] = [
  comment("c1", "Pertama", "budi", "Budi"),
  comment("c2", "Kedua", "sari", "Sari"),
];

function noop() {}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("CommentList", () => {
  it("renders comments oldest first, each with its author handle and body", () => {
    render(
      <CommentList
        postId="post-1"
        comments={THREAD}
        viewerIsMember={false}
        viewerIsOwner={false}
        onSubmitted={noop}
        onDeleted={noop}
      />
    );

    const rows = screen.getAllByRole("listitem").map((row) => row.textContent ?? "");
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain("Pertama");
    expect(rows[0]).toContain("@budi");
    expect(rows[1]).toContain("Kedua");
    expect(rows[1]).toContain("@sari");
  });

  it("shows a member the comment form", () => {
    render(
      <CommentList
        postId="post-1"
        comments={THREAD}
        viewerIsMember={true}
        viewerIsOwner={false}
        onSubmitted={noop}
        onDeleted={noop}
      />
    );

    expect(screen.getByRole("textbox", { name: "Tulis komentar" }).getAttribute("aria-label")).toBe(
      "Tulis komentar"
    );
    expect(screen.getByRole("button", { name: "Kirim" }).textContent).toBe("Kirim");
  });

  it("shows a non-member and a signed-out visitor no form at all", () => {
    render(
      <CommentList
        postId="post-1"
        comments={THREAD}
        viewerIsMember={false}
        viewerIsOwner={false}
        onSubmitted={noop}
        onDeleted={noop}
      />
    );

    expect(screen.queryAllByRole("textbox", { name: "Tulis komentar" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Kirim" }).length).toBe(0);
  });

  it("gives the author of a comment a delete control and nobody else one", () => {
    setUserSession("token-1", { ...USER, handle: "budi", displayName: "Budi" });
    render(
      <CommentList
        postId="post-1"
        comments={THREAD}
        viewerIsMember={true}
        viewerIsOwner={false}
        onSubmitted={noop}
        onDeleted={noop}
      />
    );

    const rows = screen.getAllByRole("listitem");
    const budiRow = rows.find((row) => (row.textContent ?? "").includes("@budi"));
    const sariRow = rows.find((row) => (row.textContent ?? "").includes("@sari"));
    expect(within(budiRow as HTMLElement).getAllByRole("button", { name: "Hapus" }).length).toBe(1);
    expect(within(sariRow as HTMLElement).queryAllByRole("button", { name: "Hapus" }).length).toBe(0);
  });

  it("gives the community owner a delete control on every comment", () => {
    setUserSession("token-1", { ...USER, handle: "wildan", displayName: "Wildan" });
    render(
      <CommentList
        postId="post-1"
        comments={THREAD}
        viewerIsMember={true}
        viewerIsOwner={true}
        onSubmitted={noop}
        onDeleted={noop}
      />
    );

    expect(screen.getAllByRole("button", { name: "Hapus" }).length).toBe(2);
  });

  it("shows the empty-thread copy when there are no comments", () => {
    render(
      <CommentList
        postId="post-1"
        comments={[]}
        viewerIsMember={false}
        viewerIsOwner={false}
        onSubmitted={noop}
        onDeleted={noop}
      />
    );

    expect(screen.getByText("Belum ada komentar.").textContent).toBe("Belum ada komentar.");
  });
});
