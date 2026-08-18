import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type Ref,
} from "react";
import { MAX_POST_BODY_LENGTH } from "@diudara/shared";
import { describeRequestFailure } from "./errorCopy";
import MediaStrip, { type MediaStripItem } from "./MediaStrip";
import {
  getMaxPostImages,
  mediaThumbUrl,
  subscribeToPostImageLimit,
  uploadMedia,
  type MediaView,
} from "./apiClient";

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
  /**
   * Seeds the strip — an EDIT starts from the post's current images (spec §7),
   * each one removable. Read ONCE, to build the initial state, exactly like
   * `initialBody`: a later render with a different array must not silently
   * replace photos the author has been adding to or removing from. Callers that
   * switch between posts remount instead — see `EditComposer`'s `key`.
   */
  initialMedia?: MediaView[];
  /** `Kirim` when composing, `Simpan` when editing. The caller names the action; this component does not know which it is. */
  submitLabel: string;
  /**
   * Given the TRIMMED body — the same text the server will store, since the route
   * validates and stores `body.trim()` (see `apps/api/src/routes/posts.ts`). Task
   * 2's review closed a mismatch where the two layers measured different text;
   * this component measures what it sends and sends what it measured.
   *
   * A REJECTION is meaningful: the box keeps its text AND its photos, and this
   * component shows Bahasa copy. Resolving clears both.
   *
   * `mediaIds` is the COMPLETE list of images this post should carry, in order
   * (spec §5.2) — `[]` when there are none, never `undefined`, so an edit that
   * removed every photo is distinguishable from one that never had any. Only
   * ids that finished uploading are in it; see `attachedIds`.
   */
  onSubmit: (body: string, mediaIds: string[]) => Promise<void>;
  /** Renders a `Batal` button when present. Absent for the create composer, which has nothing to cancel back to. */
  onCancel?: () => void;
  /**
   * The `<form>` element, for a caller that has to reveal this composer —
   * `EditComposer` scrolls it into view and focuses the textarea inside it
   * (whole-branch review I2). Declared as a plain prop rather than via
   * `forwardRef`, exactly like `PostFeed`'s own `ref`: React 19 passes `ref` to
   * function components as an ordinary prop and `forwardRef` is deprecated.
   */
  ref?: Ref<HTMLFormElement>;
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
 * The prefix on every UPLOAD failure — the strip's own equivalent of
 * `SUBMIT_FAILED_PREFIX`, and separate from it on purpose: one photo failing
 * to upload is not the post failing to send, and telling somebody their
 * kiriman was not saved when nothing has been sent yet would be a lie.
 */
const UPLOAD_FAILED_PREFIX = "Foto gagal diunggah.";

/**
 * One image in this composer: everything `MediaStrip` renders, plus the two
 * things only the composer needs.
 *
 * `mediaId` is the server's id and exists ONLY once the upload has landed —
 * that is the whole reason Kirim waits for uploads: a post cannot reference an
 * id that does not exist yet. `file` is what a RETRY re-sends, and is `null` on
 * an image seeded from an existing post, where there is no local file and
 * nothing to retry.
 */
interface ComposerImage extends MediaStripItem {
  mediaId: string | null;
  file: File | null;
}

/**
 * The post's existing images as strip rows. They are `ready` from the start —
 * they are already on the post — and their preview is the API's thumbnail
 * route, not a local object URL: nothing about them was chosen in this browser.
 */
function seedImages(media: MediaView[]): ComposerImage[] {
  return media.map((image) => ({
    key: image.id,
    status: "ready",
    previewUrl: mediaThumbUrl(image.id),
    error: null,
    mediaId: image.id,
    file: null,
  }));
}

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
  initialMedia,
  submitLabel,
  onSubmit,
  onCancel,
  ref,
}: PostComposerProps) {
  const [body, setBody] = useState(initialBody);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A lazy initialiser, so the seed is built once rather than on every render
  // — and so a later `initialMedia` identity change cannot reach this state.
  const [images, setImages] = useState<ComposerImage[]>(() => seedImages(initialMedia ?? []));

  /**
   * The advisory cap, learned once at boot by `App` and read here as a store so
   * a composer already on screen when the answer arrives picks it up. When
   * `GET /users/limits` never answered, this is the built-in fallback and the
   * composer works exactly as it does otherwise — spec §6.
   */
  const maxImages = useSyncExternalStore(
    subscribeToPostImageLimit,
    getMaxPostImages,
    getMaxPostImages
  );

  /**
   * Every object URL this composer has created. Revoked on removal and on
   * unmount: an object URL pins its `Blob` in memory until it is revoked or the
   * document goes away, and a phone-first app that leaks a few megabytes per
   * abandoned edit is a phone-first app that gets killed in the background.
   */
  const objectUrls = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      // Read at CLEANUP time, not at mount: `releasePreview` replaces this
      // array rather than mutating it, so a copy taken on mount would miss
      // every preview created after the first removal — measured, and pinned
      // by "frees a preview created AFTER an earlier one was removed". The ref
      // OBJECT is stable for the life of the component, which is what makes
      // reading it here safe.
      for (const url of objectUrls.current) URL.revokeObjectURL(url);
    };
  }, []);

  function previewFor(file: File): string {
    const url = URL.createObjectURL(file);
    objectUrls.current.push(url);
    return url;
  }

  /** Frees one local preview. A seeded image has no object URL and is left alone. */
  function releasePreview(image: ComposerImage): void {
    if (image.file === null || image.previewUrl === null) return;
    URL.revokeObjectURL(image.previewUrl);
    objectUrls.current = objectUrls.current.filter((url) => url !== image.previewUrl);
  }

  /**
   * Uploads one file and records the outcome AGAINST THAT ROW ONLY.
   *
   * Both branches update by `key` through a functional setState, which is what
   * makes concurrent uploads safe: several of these run at once, each one sees
   * whatever the others have already written, and an image REMOVED while its
   * upload was in flight simply matches nothing here — the orphaned upload is
   * unclaimed and swept (spec §8).
   *
   * The failure is confined to its own row: no text is touched, no other image
   * is touched, and `describeRequestFailure` turns the failure's SHAPE into
   * Bahasa (the server's raw `{ error }` string must never reach a screen — see
   * `errorCopy.ts`).
   */
  const runUpload = useCallback(async (key: string, file: File): Promise<void> => {
    try {
      const uploaded = await uploadMedia(file);
      setImages((current) =>
        current.map((image) =>
          image.key === key
            ? { ...image, status: "ready", mediaId: uploaded.id, error: null }
            : image
        )
      );
    } catch (err: unknown) {
      setImages((current) =>
        current.map((image) =>
          image.key === key
            ? {
                ...image,
                status: "failed",
                mediaId: null,
                error: `${UPLOAD_FAILED_PREFIX} ${describeRequestFailure(err)}`,
              }
            : image
        )
      );
    }
  }, []);

  /**
   * Each chosen file starts uploading IMMEDIATELY (spec §7) and shows a local
   * preview while it does.
   *
   * Only as many as there is room for: the picker is `multiple`, so somebody at
   * four of five photos can still select three, and taking all of them would
   * build a request the server refuses in full. The counter and the disabled
   * "Tambah foto" then show what was taken.
   *
   * The uploads are started OUTSIDE the state updater on purpose — an updater
   * runs twice under StrictMode, which would double every upload.
   */
  function attachFiles(files: File[]): void {
    const room = maxImages - images.length;
    if (room <= 0) return;
    const added: ComposerImage[] = files.slice(0, room).map((file) => ({
      key: crypto.randomUUID(),
      status: "uploading",
      previewUrl: previewFor(file),
      error: null,
      mediaId: null,
      file,
    }));
    setImages((current) => [...current, ...added]);
    for (const image of added) {
      // Non-null by construction here, unlike a seeded row's `file` — every
      // row in `added` was just built from one.
      if (image.file !== null) void runUpload(image.key, image.file);
    }
  }

  function removeImage(key: string): void {
    const target = images.find((image) => image.key === key);
    if (target !== undefined) releasePreview(target);
    setImages((current) => current.filter((image) => image.key !== key));
  }

  /** Re-sends the SAME file, on the same row, clearing that row's failure. */
  function retryImage(key: string): void {
    const target = images.find((image) => image.key === key);
    if (target === undefined || target.file === null) return;
    setImages((current) =>
      current.map((image) =>
        image.key === key ? { ...image, status: "uploading", error: null } : image
      )
    );
    void runUpload(key, target.file);
  }

  const trimmed = body.trim();
  const overLimit = trimmed.length > MAX_POST_BODY_LENGTH;
  const uploading = images.some((image) => image.status === "uploading");
  /**
   * **Trimmed body length above zero, and nothing else about images can widen
   * it** (spec §7.1). Body text stays required — a post carrying only images is
   * a 400 — so an attached photo must never enable Kirim on its own: widening
   * this to "text OR an image" would turn a rule the UI can enforce quietly
   * into a server error the person has to decode.
   *
   * `uploading` only ever NARROWS it: the post cannot reference an id that does
   * not exist yet. A FAILED image does not block anything — the failure is on
   * screen with a retry and a remove beside it, and holding somebody's written
   * post hostage to a photo that will not upload is worse than sending the post
   * they can see they are sending.
   */
  const canSubmit = trimmed.length > 0 && !overLimit && !submitting && !uploading;

  /** Only the ids that actually exist. A failed or in-flight image contributes nothing. */
  const attachedIds = images.flatMap((image) =>
    image.status === "ready" && image.mediaId !== null ? [image.mediaId] : []
  );

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    // Belt and braces with `disabled` below: a disabled button cannot be
    // clicked, but a form can also be submitted by Enter in some browsers and
    // by `requestSubmit()` from anywhere.
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed, attachedIds);
      // ONLY on success. See the docstring: a rejection leaves this line
      // unreached, and the text AND the photos exactly where the author left
      // them — a failed send that made somebody pick and re-upload every photo
      // would be the worst outcome available here.
      setBody("");
      for (const image of images) releasePreview(image);
      setImages([]);
    } catch (err: unknown) {
      setError(`${SUBMIT_FAILED_PREFIX} ${describeRequestFailure(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="post-composer" onSubmit={handleSubmit} ref={ref}>
      {/* Above the box, per spec §7. `busy` while the post itself is being
          sent: the list of ids in flight must not change under the request. */}
      <MediaStrip
        items={images}
        max={maxImages}
        busy={submitting}
        onAdd={attachFiles}
        onRemove={removeImage}
        onRetry={retryImage}
      />

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
