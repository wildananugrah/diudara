import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import CommentList from "./CommentList";
import { setUserSession, type CommentView } from "./apiClient";

const USER = { handle: "rina", displayName: "Rina", email: "rina@example.com" };

function comment(
  id: string,
  body: string,
  handle: string,
  displayName: string,
  parentId: string | null = null
): CommentView {
  return { id, body, createdAt: "2026-09-01T00:00:00.000Z", author: { handle, displayName }, parentId };
}

const THREAD: CommentView[] = [
  comment("c1", "Pertama", "budi", "Budi"),
  comment("c2", "Kedua", "sari", "Sari"),
];

function noop() {}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A stateful host for the cases that exercise CommentList's own writes —
 * `onSubmitted` appends, `onDeleted` removes, exactly as `DiscussionPage` wires
 * them, so a resolved delete really drops the row on screen.
 */
function Harness({
  initial,
  viewerIsMember = true,
  viewerIsOwner = false,
}: {
  initial: CommentView[];
  viewerIsMember?: boolean;
  viewerIsOwner?: boolean;
}) {
  const [comments, setComments] = useState(initial);
  return (
    <CommentList
      postId="post-1"
      comments={comments}
      viewerIsMember={viewerIsMember}
      viewerIsOwner={viewerIsOwner}
      onSubmitted={(c) => setComments((current) => [...current, c])}
      onDeleted={(id) => setComments((current) => current.filter((c) => c.id !== id))}
    />
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
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

  it("removes a comment's row on a successful delete, with no refetch", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return jsonResponse({ deleted: true });
    }) as unknown as typeof fetch;

    render(<Harness initial={THREAD} viewerIsOwner={true} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Hapus" })[0]);

    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(1));
    expect((screen.getByRole("listitem").textContent ?? "").includes("Kedua")).toBe(true);
    // Only the DELETE fired — the list is not reloaded.
    expect(calls).toEqual(["DELETE /users/comments/c1"]);
  });

  it("keeps the row and shows an alert when the delete fails", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch;

    render(<Harness initial={THREAD} viewerIsOwner={true} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Hapus" })[0]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Server sedang bermasalah. Coba lagi sebentar lagi.");
    expect(screen.getAllByRole("listitem").length).toBe(2);
  });

  it("keeps the typed body and shows an alert when the submit fails", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch;

    render(<Harness initial={THREAD} viewerIsMember={true} />);

    const box = screen.getByRole("textbox", { name: "Tulis komentar" });
    fireEvent.change(box, { target: { value: "Komentar saya" } });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Server sedang bermasalah. Coba lagi sebentar lagi.");
    // The value property, not text content — see the report's happy-dom note.
    expect((box as HTMLTextAreaElement).value).toBe("Komentar saya");
  });

  it("nests a reply under its top-level comment, not the flat list", () => {
    const withReply: CommentView[] = [
      comment("c1", "Pertama", "budi", "Budi"),
      comment("c2", "Kedua", "sari", "Sari"),
      comment("c3", "Balasan pertama", "wildan", "Wildan", "c1"),
    ];
    render(
      <CommentList
        postId="post-1"
        comments={withReply}
        viewerIsMember={false}
        viewerIsOwner={false}
        onSubmitted={noop}
        onDeleted={noop}
      />
    );

    // Two top-level rows; the reply lives nested inside c1's own row.
    expect(screen.getAllByRole("list").length).toBe(2); // the thread <ul> plus c1's replies <ul>
    const rows = screen.getAllByRole("listitem").map((row) => row.textContent ?? "");
    expect(rows.length).toBe(3);
    const c1Row = screen.getAllByRole("listitem").find((row) => (row.textContent ?? "").includes("@budi"));
    expect((c1Row?.textContent ?? "")).toContain("Balasan pertama");
  });

  it("treats a reply whose parent is gone (deleted) as a top-level row", () => {
    const orphan: CommentView[] = [
      comment("c1", "Pertama", "budi", "Budi"),
      // "c-missing" never appears among comments — its parent was deleted.
      comment("c2", "Balasan yatim", "sari", "Sari", "c-missing"),
    ];
    render(
      <CommentList
        postId="post-1"
        comments={orphan}
        viewerIsMember={false}
        viewerIsOwner={false}
        onSubmitted={noop}
        onDeleted={noop}
      />
    );

    // No nested <ul> — the orphan renders as its own top-level <li>.
    expect(screen.getAllByRole("list").length).toBe(1);
    expect(screen.getAllByRole("listitem").length).toBe(2);
  });

  it("shows a member a Balas control on both a top-level comment and a reply", () => {
    const withReply: CommentView[] = [
      comment("c1", "Pertama", "budi", "Budi"),
      comment("c3", "Balasan pertama", "wildan", "Wildan", "c1"),
    ];
    render(
      <CommentList
        postId="post-1"
        comments={withReply}
        viewerIsMember={true}
        viewerIsOwner={false}
        onSubmitted={noop}
        onDeleted={noop}
      />
    );

    expect(screen.getAllByRole("button", { name: "Balas" }).length).toBe(2);
  });

  it("hides Balas from a non-member and a signed-out visitor", () => {
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

    expect(screen.queryAllByRole("button", { name: "Balas" }).length).toBe(0);
  });

  it("submits a reply with the target comment's id as parentId, and it lands nested", async () => {
    const calls: { url: string; body: unknown }[] = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined });
      return jsonResponse(comment("new-reply", "Balasan saya", "rina", "Rina", "c1"), 201);
    }) as unknown as typeof fetch;

    render(<Harness initial={THREAD} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Balas" })[0]);
    const box = screen.getByRole("textbox", { name: "Balas Budi" });
    fireEvent.change(box, { target: { value: "Balasan saya" } });
    const replyForm = box.closest("form") as HTMLElement;
    fireEvent.click(within(replyForm).getByRole("button", { name: "Kirim" }));

    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(3));
    expect(calls).toEqual([
      { url: "/users/posts/post-1/comments", body: { body: "Balasan saya", parentId: "c1" } },
    ]);
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
