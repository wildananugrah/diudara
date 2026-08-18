import { useState, type FormEvent } from "react";
import { MAX_POST_BODY_LENGTH } from "@diudara/shared";
import { describeRequestFailure } from "./errorCopy";

export interface PostComposerProps {
  /**
   * Pre-fills the box — an EDIT starts from the post's current body. Deliberately
   * NOT clamped to `MAX_POST_BODY_LENGTH` on the way in, unlike `onChange` below:
   * this value comes from the server, which already enforced the limit, and
   * silently truncating somebody's existing post the moment they tap Edit would
   * destroy text they never touched. An over-long value therefore leaves the
   * submit button DISABLED with the counter reading over the limit, which is the
   * honest state — see `overLimit`.
   */
  initialBody?: string;
  /** `Kirim` when composing, `Simpan` when editing. The caller names the action; this component does not know which it is. */
  submitLabel: string;
  /**
   * Given the TRIMMED body — the same text the server will store, since the route
   * validates and stores `body.trim()` (see `apps/api/src/routes/posts.ts`). Task
   * 2's review closed a mismatch where the two layers measured different text;
   * this component measures what it sends and sends what it measured.
   *
   * A REJECTION is meaningful: the box keeps its text and this component shows
   * Bahasa copy. Resolving clears the box.
   */
  onSubmit: (body: string) => Promise<void>;
  /** Renders a `Batal` button when present. Absent for the create composer, which has nothing to cancel back to. */
  onCancel?: () => void;
}

/**
 * The prefix on every failure this component shows. The sentence itself comes
 * from `describeRequestFailure` and NEVER from the server's `{ error }` string —
 * see `errorCopy.ts` and `src/test/no-raw-server-errors.test.ts` for the four
 * separate times a raw English server message reached a member-facing screen
 * before that rule existed.
 */
const SUBMIT_FAILED_PREFIX = "Kiriman gagal disimpan.";

/**
 * The one box a member types a post into — used BOTH for composing a new post
 * and for editing an existing one, since the two differ only in the button's
 * label, the initial text, and whether there is anything to cancel back to.
 *
 * **A failed submit keeps the text.** That is the whole reason `onSubmit`
 * returns a promise this component awaits rather than a fire-and-forget
 * callback: losing what somebody wrote is the worst outcome available here, and
 * it is the same rule `PostFeed` follows when a failed "load more" leaves the
 * already-loaded posts on screen.
 *
 * **The limit is bounded twice, and both are `MAX_POST_BODY_LENGTH`** — the
 * `maxLength` attribute, which is what a real browser applies to typing and
 * pasting, and a `.slice()` in `onChange`, which is what bounds every other way
 * a value can arrive. Exactly how `JelajahPage` bounds `?q=` at
 * `MAX_EXPLORE_QUERY_LENGTH`, for the same reason: a limit known only to the
 * server put a raw English Zod message on a user's screen once already.
 *
 * The counter and the disabled state both measure the TRIMMED length, because
 * the server validates the trimmed body. Measuring the raw length here would
 * re-open Task 2's mismatch from the other side: a box of 1000 spaces would
 * read "1000/1000" and offer to send a post the server calls empty.
 */
export default function PostComposer({
  initialBody = "",
  submitLabel,
  onSubmit,
  onCancel,
}: PostComposerProps) {
  const [body, setBody] = useState(initialBody);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = body.trim();
  const overLimit = trimmed.length > MAX_POST_BODY_LENGTH;
  const canSubmit = trimmed.length > 0 && !overLimit && !submitting;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    // Belt and braces with `disabled` below: a disabled button cannot be
    // clicked, but a form can also be submitted by Enter in some browsers and
    // by `requestSubmit()` from anywhere.
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      // ONLY on success. See the docstring: a rejection leaves this line
      // unreached and the text exactly where the author left it.
      setBody("");
    } catch (err: unknown) {
      setError(`${SUBMIT_FAILED_PREFIX} ${describeRequestFailure(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="post-composer" onSubmit={handleSubmit}>
      <textarea
        className="post-composer-body"
        value={body}
        // Clamped here as well as by `maxLength` — see the docstring.
        onChange={(event) => setBody(event.target.value.slice(0, MAX_POST_BODY_LENGTH))}
        maxLength={MAX_POST_BODY_LENGTH}
        placeholder="Apa yang terjadi?"
        aria-label="Apa yang terjadi?"
        rows={3}
      />

      <div className="post-composer-actions">
        {/* A single text node, so a test's `getByText("0/1000")` sees one
            string rather than three adjacent nodes. */}
        <span className={overLimit ? "post-composer-counter over" : "post-composer-counter"}>
          {`${trimmed.length}/${MAX_POST_BODY_LENGTH}`}
        </span>
        {onCancel !== undefined ? (
          <button type="button" className="button-quiet" onClick={onCancel} disabled={submitting}>
            Batal
          </button>
        ) : null}
        <button type="submit" className="button-primary" disabled={!canSubmit}>
          {submitLabel}
        </button>
      </div>

      {/* `role="alert"` matches every other request-failure element under
          src/user — FollowButton, LoginPage, SignupPage, PostFeed. */}
      {error !== null ? (
        <p className="post-composer-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
