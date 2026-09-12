import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type Ref,
} from "react";
import {
  EVENT_POST_TYPE,
  MAX_EVENT_LOCATION_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  MAX_POST_BODY_LENGTH,
} from "@diudara/shared";
import { describeRequestFailure, describeUploadFailure } from "./errorCopy";
import { wibWallClockToIso } from "./wibDate";
import MediaStrip, { type MediaStripItem } from "./MediaStrip";
import {
  getMaxPostImages,
  MAX_UPLOAD_BYTES,
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
  /**
   * Seeds "Khusus anggota" — an EDIT starts checked exactly when the post is
   * currently `members`, unchecked otherwise (spec §7). Defaults to
   * `"public"`, which is what the CREATE composer always gets (there is no
   * post yet to be members-only). Read ONCE, exactly like `initialBody` and
   * `initialMedia`: it is also the yardstick `resolveVisibility` compares
   * the checkbox's FINAL state against, so this component can tell "the
   * creator left it alone" from "the creator changed it back to what it
   * already was" — both send nothing, but only the first is really "nothing
   * changed" and the distinction is exactly what an untouched-field-omitted
   * PATCH requires.
   */
  initialVisibility?: "public" | "members";
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
   *
   * `visibility` is passed ONLY when the checkbox's FINAL state differs from
   * `initialVisibility` — `"members"` when checked away from public,
   * `"public"` when unchecked away from members — and OMITTED (not
   * `undefined`, genuinely absent from the call) whenever it matches the
   * seed, whether that is because the creator never touched the box or
   * because they toggled it and toggled it back. That mirrors the API's own
   * contract (spec §7): on the write path `visibility` is optional and an
   * omitted value on an edit means "leave it alone", not "make it public".
   * A caller wired to `editPost` never has to guess what an omitted
   * argument meant — this component already resolved that.
   */
  onSubmit: (
    body: string,
    mediaIds: string[],
    visibility?: "public" | "members",
    /**
     * **Phase 3, and ONLY ever set in community mode when the chosen type is
     * `kegiatan`.** An OBJECT in slot four beside a STRING in slot three, so
     * transposing the two is a compile error rather than a silent mis-store —
     * the hazard `post-repository.port.ts` records when it rejected trailing
     * positional strings. Reshaping this into an options bag would touch all
     * three existing callers to serve one new one.
     *
     * `startsAt`/`endsAt` are UTC instants. The native inputs above produce a
     * WIB wall clock and THIS component converts, so no caller has to know
     * the form's timezone.
     */
    event?: { title: string; startsAt: string; endsAt?: string; location?: string }
  ) => Promise<void>;
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
  /**
   * **Task 8 — the community feed's ONE variant hook.** When present the
   * composer is in "community mode": the "Khusus anggota" visibility block is
   * gone (a community post is never members-only gated), and — if the array is
   * NON-empty — a post-type `<select>` takes its place, offering exactly these
   * choices. On submit the chosen type is passed as `onSubmit`'s third
   * argument, where a visibility normally goes.
   *
   * `CommunityFeed` passes `COMMUNITY_POST_TYPES` (from `@diudara/shared`,
   * ruling R5) **only when the viewer owns the community**, and an empty array
   * for a plain member — who then sees no selector at all and whose every
   * submit is a `diskusi`. Never a disabled or hidden-but-present selector.
   * `undefined` (the default, and what Beranda/profiles pass) leaves the
   * visibility block exactly as it was.
   */
  postTypeChoices?: readonly string[];
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
 * How many photos were dropped, and why — one Bahasa sentence per reason.
 *
 * Both reasons count PHOTOS rather than describing the rule, because that is
 * the part ambient state cannot convey: "5/5 foto" says the strip is full and
 * says nothing about the three that were just discarded. Indonesian does not
 * inflect for plural, so one sentence shape serves any count.
 */
function droppedNotice(count: number, reason: string): string {
  return `${count} foto tidak ditambahkan — ${reason}.`;
}

/** The size limit as a whole number of MB, derived so the copy cannot drift from the constant. */
const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / (1024 * 1024);

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
 * a value can arrive. Exactly how `DiscoverPage` bounds `?q=` at
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
  initialVisibility = "public",
  submitLabel,
  onSubmit,
  onCancel,
  ref,
  postTypeChoices,
}: PostComposerProps) {
  const [body, setBody] = useState(initialBody);
  /**
   * Task 8. `postTypeChoices !== undefined` means a community post: no
   * "Khusus anggota" block, and — when the list is non-empty (owner only) — a
   * type `<select>` in its place. The selected type rides out on `onSubmit`'s
   * third argument.
   */
  const communityMode = postTypeChoices !== undefined;
  const [postType, setPostType] = useState<string>(postTypeChoices?.[0] ?? "diskusi");
  // Phase 3. Five fields, flat rather than one object, because each is a
  // controlled input and an object would re-create every one of them on any
  // keystroke. They are NOT cleared when the type changes away from
  // `kegiatan`: switching to Pengumuman to check something and back must not
  // wipe a half-typed schedule. `eventDraft` reads them only when the type
  // is `kegiatan`, so a stale value cannot be sent.
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventStartTime, setEventStartTime] = useState("");
  const [eventEndTime, setEventEndTime] = useState("");
  const [eventLocation, setEventLocation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A lazy initialiser, so the seed is built once rather than on every render
  // — and so a later `initialMedia` identity change cannot reach this state.
  const [images, setImages] = useState<ComposerImage[]>(() => seedImages(initialMedia ?? []));
  /**
   * What the LAST pick could not take (fix round 1, Important 2). Recomputed by
   * every pick and cleared by anything that makes it stale — see `attachFiles`
   * and `removeImage`.
   */
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * "Khusus anggota" (spec §7). `visibility = 'members'` requires at least
   * one image, and **the server enforces that** — this state is a courtesy
   * that explains the rule before the creator hits it, never the rule
   * itself. Nothing here assumes the checkbox is the only way the field
   * gets set; it is only ever this component's own opinion of what THIS
   * submit should ask for.
   */
  const [membersOnly, setMembersOnly] = useState(initialVisibility === "members");
  /**
   * The seed `membersOnly` STARTED at, captured once and never updated —
   * `resolveVisibility` compares the checkbox's final state against this,
   * not against `initialVisibility` the prop, because a `useRef` initial
   * value is exactly as "read once" as `useState`'s lazy initialiser is, and
   * writing it as a second `useState` would invite a future edit to call its
   * setter and quietly move the goalposts of what counts as "unchanged".
   */
  const initialMembersOnly = useRef(initialVisibility === "members").current;

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
                error: `${UPLOAD_FAILED_PREFIX} ${describeUploadFailure(err)}`,
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
    const room = Math.max(0, maxImages - images.length);
    // Order matters: a file that is too big is not "one that did not fit", so
    // it is counted against its own reason first and never occupies a slot.
    const smallEnough = files.filter((file) => file.size <= MAX_UPLOAD_BYTES);
    const oversized = files.length - smallEnough.length;
    const overLimitCount = Math.max(0, smallEnough.length - room);

    const sentences: string[] = [];
    if (oversized > 0) {
      sentences.push(droppedNotice(oversized, `ukuran foto maksimal ${MAX_UPLOAD_MB} MB`));
    }
    if (overLimitCount > 0) {
      sentences.push(droppedNotice(overLimitCount, `maksimal ${maxImages} foto per kiriman`));
    }
    // Always written, never only when non-empty: a clean pick must clear what
    // the previous one said, or a stale count sits there describing photos the
    // person has since dealt with.
    setNotice(sentences.length > 0 ? sentences.join(" ") : null);

    const added: ComposerImage[] = smallEnough.slice(0, room).map((file) => ({
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
    const remaining = images.filter((image) => image.key !== key);
    setImages(remaining);
    // The notice counts photos a PAST pick could not take. Removing one makes
    // room, so repeating it would misdescribe what can be added now.
    setNotice(null);
    // Removing the LAST image un-checks "Khusus anggota" rather than leaving
    // an unenforceable lock armed (spec §7): without this, a creator clears
    // their images, submits, and gets a server error they did not cause on
    // purpose. Only the last one does this — taking a post from two photos
    // to one leaves the lock exactly as enforceable as it was.
    if (remaining.length === 0) setMembersOnly(false);
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
  /**
   * Whether the type currently chosen needs a schedule. False for every
   * non-community caller, so Beranda and profiles are untouched.
   */
  const isEvent = communityMode && postType === EVENT_POST_TYPE;

  /**
   * The `event` payload, or `null` when the form is not yet a valid one.
   * `null` is what disables the submit button, so this is the single
   * definition of "is this schedule complete" — a second copy in `canSubmit`
   * is how a button enables for a payload this refuses to build.
   *
   * `endsAt` and `location` are OMITTED when blank, never sent as `""`: the
   * route's schema requires at least one character after trimming, so an
   * empty string would 400 a form the author thinks they left alone.
   */
  function eventDraft(): { title: string; startsAt: string; endsAt?: string; location?: string } | null {
    const title = eventTitle.trim();
    const startsAt = wibWallClockToIso(eventDate, eventStartTime);
    if (title.length === 0 || startsAt === null) return null;

    const endsAt = eventEndTime === "" ? null : wibWallClockToIso(eventDate, eventEndTime);
    // A typed-but-unparseable or not-after end time refuses the whole draft
    // rather than silently dropping the field — the client half of the
    // `community_event_ends_after_starts` CHECK, so a violation is a disabled
    // button instead of an opaque 400.
    if (eventEndTime !== "" && (endsAt === null || endsAt <= startsAt)) return null;

    const location = eventLocation.trim();
    return {
      title,
      startsAt,
      ...(endsAt === null ? {} : { endsAt }),
      ...(location === "" ? {} : { location }),
    };
  }

  const canSubmit =
    trimmed.length > 0 &&
    !overLimit &&
    !submitting &&
    !uploading &&
    (!isEvent || eventDraft() !== null);

  /**
   * Whether "Khusus anggota" may be checked at all — at least one image is
   * ATTACHED, counting the same way the strip's own limit does (`images`,
   * not `attachedIds`): a photo still uploading is not yet enforceable
   * server-side, but it is not nothing either, and disabling the box the
   * instant a pick lands (before the network answers) would be a worse UI
   * than the one-beat delay of waiting for `attachedIds`.
   */
  const canBeMembersOnly = images.length > 0;

  /** Only the ids that actually exist. A failed or in-flight image contributes nothing. */
  const attachedIds = images.flatMap((image) =>
    image.status === "ready" && image.mediaId !== null ? [image.mediaId] : []
  );

  /**
   * What to tell `onSubmit` about "Khusus anggota" — `undefined` (genuinely
   * omitted, not sent as the literal `undefined`) when the checkbox's FINAL
   * state matches what it STARTED at, and an explicit `"members"` or
   * `"public"` when it does not.
   *
   * This is the whole reason `initialMembersOnly` is captured once rather
   * than read live from the prop: on an EDIT, a creator who never touches
   * the box must produce an omitted field (spec §7 — "leave it alone"), and
   * so must a creator who checks it and then unchecks it again before
   * saving. Only an ACTUAL change from what the post already is produces an
   * explicit value. On CREATE, `initialMembersOnly` is always `false`, so
   * this collapses to exactly the old behaviour: checked sends `"members"`,
   * unchecked sends nothing.
   */
  function resolveVisibility(): "public" | "members" | undefined {
    if (membersOnly === initialMembersOnly) return undefined;
    return membersOnly ? "members" : "public";
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    // Belt and braces with `disabled` below: a disabled button cannot be
    // clicked, but a form can also be submitted by Enter in some browsers and
    // by `requestSubmit()` from anywhere.
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      if (communityMode) {
        // Task 8: the third argument carries the post TYPE, not a visibility —
        // `CommunityFeed.handleCreate` reads it as such. The cast is LOCAL:
        // widening the public `onSubmit` type to `string` would break every
        // existing narrow caller (Beranda's `handleCreate`, the edit
        // composer). An empty `postTypeChoices` (a plain member) sends no type
        // — the server defaults it to `diskusi`.
        if (postTypeChoices !== undefined && postTypeChoices.length > 0) {
          // TRAP: in community mode this third slot — typed `visibility` for
          // every other caller — carries the post `type` string instead. No
          // existing caller (Beranda, EditComposer) reaches this branch;
          // `communityMode` is false for them.
          // The third slot carries the post TYPE here, not a visibility (see
          // the TRAP note above). The fourth carries the schedule, and is
          // `undefined` for every type but `kegiatan`.
          const draft = isEvent ? eventDraft() : null;
          await onSubmit(
            trimmed,
            attachedIds,
            postType as "public" | "members",
            draft ?? undefined
          );
        } else {
          await onSubmit(trimmed, attachedIds);
        }
      } else {
        // `visibility` is passed ONLY when it actually changed — see
        // `resolveVisibility` and the prop's own docstring for why an
        // unchanged box omits the argument entirely rather than sending it as
        // `undefined`.
        const visibility = resolveVisibility();
        if (visibility !== undefined) {
          await onSubmit(trimmed, attachedIds, visibility);
        } else {
          await onSubmit(trimmed, attachedIds);
        }
      }
      // ONLY on success. See the docstring: a rejection leaves this line
      // unreached, and the text AND the photos exactly where the author left
      // them — a failed send that made somebody pick and re-upload every photo
      // would be the worst outcome available here.
      setBody("");
      for (const image of images) releasePreview(image);
      setImages([]);
      setNotice(null);
      setMembersOnly(false);
      setEventTitle("");
      setEventDate("");
      setEventStartTime("");
      setEventEndTime("");
      setEventLocation("");
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
        notice={notice}
        onAdd={attachFiles}
        onRemove={removeImage}
        onRetry={retryImage}
      />

      {/* Task 8: in community mode the "Khusus anggota" block is gone — a
          community post is never members-only gated. An OWNER (non-empty
          choices) gets a type <select> in its place; a plain member (empty
          choices) gets nothing, and every submit is a `diskusi`. */}
      {postTypeChoices !== undefined ? (
        postTypeChoices.length > 0 ? (
          <div className="post-composer-type">
            <label htmlFor="post-composer-type">Jenis kiriman</label>
            <select
              id="post-composer-type"
              value={postType}
              onChange={(event) => setPostType(event.target.value)}
            >
              {postTypeChoices.map((choice) => (
                <option key={choice} value={choice}>
                  {choice.charAt(0).toUpperCase() + choice.slice(1)}
                </option>
              ))}
            </select>
          </div>
        ) : null
      ) : (
        /* "Khusus anggota" (spec §7). Disabled until an image is attached —
           a courtesy that explains the server's own rule before the creator
           hits it, not the rule itself. */
        <div className="post-composer-members-only">
          <label htmlFor="post-composer-members-only">
            <input
              id="post-composer-members-only"
              type="checkbox"
              checked={membersOnly}
              disabled={!canBeMembersOnly}
              onChange={(event) => setMembersOnly(event.target.checked)}
            />
            Khusus anggota
          </label>
          {!canBeMembersOnly ? (
            <p className="post-composer-hint" data-testid="members-only-hint">
              Tambahkan foto dulu — teks selalu bisa dibaca semua orang.
            </p>
          ) : null}
        </div>
      )}

      {/* Phase 3. Shown only for `kegiatan`, so every other type and every
          non-community caller renders exactly what it did before.

          NATIVE `<input type="date">` and `<input type="time">` — a
          date-picker dependency for a form with one date in it is the kind of
          addition this repo does not make, and the native controls are
          already keyboard- and screen-reader-correct, and localised by the
          browser rather than by us.

          The times are WIB wall clock; `eventDraft` converts. The hint says
          so, because an input that silently means a timezone is an input
          that schedules things seven hours out. */}
      {isEvent ? (
        <fieldset className="post-composer-event">
          <legend>Jadwal kegiatan</legend>

          <label htmlFor="post-composer-event-title">Judul kegiatan</label>
          <input
            id="post-composer-event-title"
            type="text"
            value={eventTitle}
            maxLength={MAX_EVENT_TITLE_LENGTH}
            onChange={(event) => setEventTitle(event.target.value)}
          />

          <label htmlFor="post-composer-event-date">Tanggal</label>
          <input
            id="post-composer-event-date"
            type="date"
            value={eventDate}
            onChange={(event) => setEventDate(event.target.value)}
          />

          <label htmlFor="post-composer-event-start">Waktu mulai</label>
          <input
            id="post-composer-event-start"
            type="time"
            value={eventStartTime}
            onChange={(event) => setEventStartTime(event.target.value)}
          />

          <label htmlFor="post-composer-event-end">Waktu selesai</label>
          <input
            id="post-composer-event-end"
            type="time"
            value={eventEndTime}
            onChange={(event) => setEventEndTime(event.target.value)}
          />

          <label htmlFor="post-composer-event-location">Lokasi</label>
          <input
            id="post-composer-event-location"
            type="text"
            value={eventLocation}
            maxLength={MAX_EVENT_LOCATION_LENGTH}
            placeholder="Opsional — misalnya Online via Zoom"
            onChange={(event) => setEventLocation(event.target.value)}
          />

          <p className="post-composer-hint">Semua waktu dalam WIB.</p>
        </fieldset>
      ) : null}

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
          <button type="button" className="button-quiet btn btn-ghost btn-sm" onClick={onCancel} disabled={submitting}>
            Batal
          </button>
        ) : null}
        <button type="submit" className="button-primary btn btn-sm" disabled={!canSubmit}>
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
