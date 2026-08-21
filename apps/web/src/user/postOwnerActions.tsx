import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import PostComposer from "./PostComposer";
import { deletePost, editPost, type PostView } from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import type { PostFeedHandle } from "./PostFeed";

/**
 * The prefix on every delete failure a page shows. The sentence itself comes
 * from `describeRequestFailure` and NEVER from the server's `{ error }` string
 * — see `errorCopy.ts` and `src/test/no-raw-server-errors.test.ts`.
 */
export const DELETE_FAILED_PREFIX = "Gagal menghapus kiriman.";

/** Everything a page needs to run the owner-actions flow. See `usePostOwnerActions`. */
export interface PostOwnerActions {
  /** The post being edited, or `null` when nothing is. Never a boolean plus an id — the composer needs the body to pre-fill. */
  editing: PostView | null;
  /** The id awaiting confirmation. `null` means nothing is being deleted; there is no separate "confirming" flag to drift out of step with it. */
  pendingDelete: string | null;
  deleting: boolean;
  deleteError: string | null;
  /** Wire straight to `PostFeed`'s `onEdit`. */
  onEdit: (post: PostView) => void;
  /** Wire straight to `PostFeed`'s `onDeleteRequested`. */
  onDeleteRequested: (id: string) => void;
  confirmDelete: () => Promise<void>;
  cancelDelete: () => void;
  /** The edit composer's "Batal". Its own function rather than a raw `setEditing` a page could misuse. */
  cancelEdit: () => void;
  saveEdit: (body: string, mediaIds: string[], visibility?: "public" | "members") => Promise<void>;
}

/**
 * **The owner-actions flow — edit and delete your own post — held in ONE
 * place, for every page that renders a `PostFeed` with owner controls.**
 *
 * It used to be written twice, in `BerandaPage` and `ProfilePage`: four
 * `useState` declarations, the per-context reset effect, both `PostFeed`
 * callbacks, the confirmation panel, the edit composer, the error paragraph
 * and `DELETE_FAILED_PREFIX`, with `handleSaveEdit` and `confirmDelete`
 * differing by exactly one line each (the feed ref's name). The whole-branch
 * review extracted it, and the ledger records what the duplication had already
 * cost inside this one phase: Task 6 copied the panel but not the reset
 * effect, which produced a DELETE fired against the wrong person's post from a
 * confirmation panel that had survived a navigation to another profile.
 *
 * `feed` is the page's `PostFeedHandle` ref — the ONLY way anybody outside
 * `PostFeed` may change the list it owns (see `PostFeedHandle`'s docstring).
 *
 * `resetKey` is what "a different list" means to this page: `tab` on Beranda,
 * `handle` on a profile. **Everything above is about a row in the list the
 * page is CURRENTLY showing, and a change of key replaces that list
 * wholesale**, so all of it is dropped when the key changes. An effect rather
 * than the tab buttons' `onClick`, because the key also changes on
 * back/forward, on a shared link, and on an in-app link from one profile to
 * another, none of which go through any handler. It runs on mount too, where
 * every setter is already at its initial value — React bails out of an equal
 * `useState` write, so that costs no extra render.
 */
export function usePostOwnerActions(
  feed: RefObject<PostFeedHandle | null>,
  resetKey: string
): PostOwnerActions {
  const [editing, setEditing] = useState<PostView | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setEditing(null);
    setPendingDelete(null);
    setDeleteError(null);
  }, [resetKey]);

  // Fix round 1: opening Edit for one post must close a delete confirmation
  // for another (or the same) post, or both panels can render at once.
  const onEdit = useCallback((post: PostView) => {
    setDeleteError(null);
    setPendingDelete(null);
    setEditing(post);
  }, []);

  // `PostCard` raises this on the TAP, not after a delete — nothing has been
  // removed yet. Confirmation happens here. Symmetric with `onEdit` above
  // (fix round 1) — requesting a delete must close an open edit composer.
  const onDeleteRequested = useCallback((id: string) => {
    setDeleteError(null);
    setEditing(null);
    setPendingDelete(id);
  }, []);

  const cancelDelete = useCallback(() => setPendingDelete(null), []);
  const cancelEdit = useCallback(() => setEditing(null), []);

  const saveEdit = useCallback(
    async (body: string, mediaIds: string[], visibility?: "public" | "members"): Promise<void> => {
      const target = editing;
      if (target === null) return;
      // Deliberately NOT wrapped in try/catch: a rejection has to reach
      // `PostComposer`, which is what keeps the author's text AND its photos
      // and shows the error. Swallowing it here would clear the box on a
      // failed save.
      //
      // `mediaIds` is the COMPLETE desired list, not a delta (spec §5.2) — the
      // composer seeded itself with this post's images, so what comes back is
      // the final state, including `[]` when every image was removed.
      //
      // `visibility` is passed straight through, UNTOUCHED — `PostComposer`
      // already resolved "the creator did not change this" into a genuinely
      // omitted argument (see its own `resolveVisibility`), so this function
      // must not "helpfully" default it to anything. Doing so is exactly the
      // bug spec §7 calls out by name: an omitted `visibility` on an edit
      // silently un-gating a members-only post.
      const updated = await editPost(target.id, body, mediaIds, visibility);
      feed.current?.replace(updated);
      setEditing(null);
    },
    [editing, feed]
  );

  const confirmDelete = useCallback(async (): Promise<void> => {
    const id = pendingDelete;
    if (id === null) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deletePost(id);
      feed.current?.remove(id);
      setPendingDelete(null);
      // There is deliberately NO `if (editing?.id === id) setEditing(null)`
      // here. It used to sit on both pages, commented as a guard against a
      // composer left saving into a 404 — and the whole-branch review proved
      // it dead two ways: deleting it left the suite fully green, and the
      // state machine settles it, since `onDeleteRequested` is the only writer
      // of `pendingDelete` and it calls `setEditing(null)` first. So
      // `confirmDelete` can never observe a non-null `editing`. A dead guard
      // whose comment describes a hazard it no longer guards is worse than no
      // guard: the next reader believes the hazard is live.
    } catch (err: unknown) {
      setDeleteError(`${DELETE_FAILED_PREFIX} ${describeRequestFailure(err)}`);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, feed]);

  return {
    editing,
    pendingDelete,
    deleting,
    deleteError,
    onEdit,
    onDeleteRequested,
    confirmDelete,
    cancelDelete,
    cancelEdit,
    saveEdit,
  };
}

/**
 * The "Hapus kiriman ini?" confirmation panel — rendered by every page with
 * owner controls, from the same source, so the two can never drift.
 *
 * **It brings itself into view and takes focus** (whole-branch review, I2).
 * This panel renders ABOVE the feed, so measured with 20 posts loaded, tapping
 * Hapus on the 20th inserted it roughly twenty rows above the viewport with
 * `document.activeElement` still on `body`. On a 390px phone — four to six
 * cards per screen, and this audience is phone-first — that means from about
 * the sixth post down, tapping Hapus appeared to do nothing at all. Neither
 * happy-dom (no layout) nor the browser gate (Playwright's `.click()`
 * auto-scrolls) can see that, which is why it survived a 59-check gate.
 *
 * `role="alertdialog"` — the role `MembersPage`'s two confirmation panels
 * already use — so a screen reader announces it on arrival rather than leaving
 * it as an unremarked group. `tabIndex={-1}` makes the panel focusable by
 * script without putting it in the tab order; focus lands on the PANEL and
 * never on "Ya, hapus", so a stray Enter cannot delete a post.
 */
export function DeleteConfirm({
  postId,
  deleting,
  onConfirm,
  onCancel,
}: {
  /** The post awaiting confirmation. Keys the reveal below, so re-opening for a DIFFERENT post scrolls and focuses again — the panel itself never unmounts in between. */
  postId: string;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = panel.current;
    if (node === null) return;
    node.scrollIntoView({ block: "center" });
    node.focus();
  }, [postId]);

  return (
    <div
      className="delete-confirm"
      role="alertdialog"
      aria-label="Konfirmasi hapus"
      tabIndex={-1}
      ref={panel}
    >
      <p>Hapus kiriman ini?</p>
      {/* "Tidak jadi" rather than "Batal", which the edit composer already
          uses — two buttons with one accessible name is an ambiguity a screen
          reader and `getByRole` both have to resolve by position. */}
      <button type="button" className="button-primary" disabled={deleting} onClick={onConfirm}>
        Ya, hapus
      </button>
      <button type="button" className="button-quiet" disabled={deleting} onClick={onCancel}>
        Tidak jadi
      </button>
    </div>
  );
}

/**
 * The edit composer — a `PostComposer` pre-filled with the post's body AND its
 * images, that brings itself into view and puts the caret in the box.
 *
 * "Batal" discards the whole edit, including any photo uploaded during it
 * (spec §7): this component unmounts, the ids it uploaded are never sent, and
 * an unclaimed upload is swept by §8 like any other orphan.
 *
 * Keyed on `post.id`: editing post A then post B without the key silently
 * saves A's text over B, because `initialBody` only seeds `useState` and does
 * not reset it on a later render (Beranda's own fix round 1 measured this).
 *
 * The reveal is the same I2 fix as `DeleteConfirm` above and for the same
 * measured reason — this composer also renders above the feed, so an edit
 * opened from the twentieth card appeared to do nothing. Focus goes to the
 * TEXTAREA rather than the form, because the box is the thing the author came
 * here to type in. The `key` remounts `PostComposer` per post while the effect
 * below is keyed on the same id, so the two stay in step.
 */
export function EditComposer({
  post,
  onSubmit,
  onCancel,
}: {
  post: PostView;
  onSubmit: (body: string, mediaIds: string[], visibility?: "public" | "members") => Promise<void>;
  onCancel: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const node = form.current;
    if (node === null) return;
    node.scrollIntoView({ block: "center" });
    node.querySelector("textarea")?.focus();
  }, [post.id]);

  return (
    <PostComposer
      key={post.id}
      ref={form}
      initialBody={post.body}
      // Seeded with the post's own images (spec §7), each removable. `key`
      // above remounts per post, which is what stops one post's strip being
      // carried into another's edit — `initialMedia` is read once, exactly
      // like `initialBody`.
      initialMedia={post.media}
      // Seeds "Khusus anggota" from what the post already is (spec §7), so
      // the checkbox never lies about a post's current state — and so
      // `PostComposer`'s own `resolveVisibility` has the right baseline to
      // compare "did the creator actually change this" against.
      initialVisibility={post.membersOnly ? "members" : "public"}
      submitLabel="Simpan"
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}
