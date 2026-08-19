import { useRef, type ChangeEvent } from "react";

/**
 * Where one image in the strip is in its life. There is no "removed" state:
 * a removed image is gone from the list, so nothing can render it or send it.
 */
export type MediaUploadStatus = "uploading" | "ready" | "failed";

/**
 * One image in the strip, as this component needs to see it.
 *
 * Deliberately NOT the same shape the composer holds — that one also carries
 * the server's id and the `File` a retry re-sends, neither of which this
 * component has any business knowing. `key` is the strip's own identity for a
 * row and is what every callback reports back: an image being uploaded has no
 * server id yet and a failed one may never get one, so the id cannot be the
 * handle for "remove THIS one".
 *
 * `error` is a finished Bahasa sentence. The composer builds it through
 * `describeUploadFailure` (`PostComposer.tsx`), so a server's raw `{ error }`
 * string can never reach a screen through here (see
 * `src/test/no-raw-server-errors.test.ts`).
 */
export interface MediaStripItem {
  key: string;
  status: MediaUploadStatus;
  /** An object URL for a freshly chosen file, or `/users/media/:id/thumb` for one already on the post. `null` renders no `<img>` at all. */
  previewUrl: string | null;
  error: string | null;
}

export interface MediaStripProps {
  items: MediaStripItem[];
  /** The advisory cap from `GET /users/limits` — see `loadPostImageLimit`. The server stays the authority. */
  max: number;
  /** True while the POST/PATCH itself is in flight: the list being sent must not change under it. */
  busy: boolean;
  /**
   * One Bahasa sentence about the LAST pick — how many photos were not added,
   * and why — or `null` when there is nothing to say.
   *
   * Fix round 1, Important 2. The composer drops files it cannot take (over the
   * size limit, or past the image limit), and that is an EVENT: "I dropped three
   * of the eight you just chose." The counter and a disabled "Tambah foto" are
   * AMBIENT state — they can say no more fit, they can never say how many were
   * lost or why. This is where the composer says it.
   */
  notice: string | null;
  onAdd: (files: File[]) => void;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}

/**
 * **The composer's strip of photos** — previews, per-image progress, per-image
 * failure with a retry, per-image removal, and the "Tambah foto" button that
 * opens the file picker (spec §7).
 *
 * Purely presentational: it holds no state, starts no request, and knows
 * nothing about uploading. `PostComposer` owns all of that, which is what keeps
 * the one rule that matters — **an attached photo never enables Kirim on its
 * own** (spec §7.1) — in the component that owns the submit button, rather than
 * split across two.
 *
 * There is deliberately NO drag-to-reorder: spec §5.2 defers it, because touch
 * reordering on a 390px screen is its own piece of work. Adding and removing
 * fixes the mistake people actually make, and the API already accepts a
 * reordered list when a later phase builds the interaction.
 */
export default function MediaStrip({
  items,
  max,
  busy,
  notice,
  onAdd,
  onRemove,
  onRetry,
}: MediaStripProps) {
  const picker = useRef<HTMLInputElement>(null);

  /**
   * Every image counts, whatever its state. One still uploading occupies a slot
   * the person can see and its id is going onto the post; counting only the
   * finished ones would let five uploads in flight become a sixth attachment
   * the server then refuses.
   */
  const atLimit = items.length >= max;

  function handleChosen(event: ChangeEvent<HTMLInputElement>): void {
    const chosen = [...(event.target.files ?? [])];
    // Cleared so choosing the SAME file again still fires `change`. Without
    // this, a person who removes a photo and picks it again taps a button that
    // does nothing, because the input's value never changed.
    event.target.value = "";
    if (chosen.length > 0) onAdd(chosen);
  }

  return (
    <div className="media-strip">
      {items.length > 0 ? (
        <ul className="media-strip-items" aria-label="Foto kiriman">
          {items.map((item, index) => {
            // 1-based, because these names are read aloud and printed in test
            // failures: "Hapus foto 2" is the second photo, not the third.
            const position = index + 1;
            return (
              <li key={item.key} className={`media-strip-item ${item.status}`}>
                {/* No `<img>` at all rather than `src=""`, which a browser
                    resolves against the page URL and re-fetches the document. */}
                {item.previewUrl !== null ? (
                  <img
                    className="media-strip-preview"
                    src={item.previewUrl}
                    alt={`Pratinjau foto ${position}`}
                  />
                ) : null}

                {/* Indeterminate on purpose: `fetch` reports no upload
                    progress, so a percentage here would be invented. This says
                    "this one is still going", which is the fact the person
                    needs while Kirim is disabled. */}
                {item.status === "uploading" ? (
                  <span
                    className="media-strip-progress"
                    role="progressbar"
                    aria-label={`Mengunggah foto ${position}`}
                  >
                    Mengunggah…
                  </span>
                ) : null}

                {/* Offered in every state — an upload that is stuck or has
                    failed must not be something the person is stuck with. */}
                <button
                  type="button"
                  className="media-strip-remove"
                  aria-label={`Hapus foto ${position}`}
                  disabled={busy}
                  onClick={() => onRemove(item.key)}
                >
                  <span aria-hidden="true">×</span>
                </button>

                {item.status === "failed" ? (
                  <>
                    <p className="media-strip-error" role="alert">
                      {item.error}
                    </p>
                    {/* The visible label stays short for a 390px screen; the
                        accessible name says WHICH photo, since a strip can
                        hold several failures at once. */}
                    <button
                      type="button"
                      className="button-quiet"
                      aria-label={`Coba lagi unggah foto ${position}`}
                      disabled={busy}
                      onClick={() => onRetry(item.key)}
                    >
                      Coba lagi
                    </button>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="media-strip-actions">
        {/* Hidden, and driven by the button beside it: a bare file input reads
            as "Browse… no file selected" and cannot be styled for a phone. */}
        <input
          ref={picker}
          data-testid="media-picker"
          className="media-strip-picker"
          type="file"
          accept="image/*"
          multiple
          aria-label="Pilih foto"
          onChange={handleChosen}
        />
        <button
          type="button"
          className="button-quiet"
          disabled={busy || atLimit}
          onClick={() => picker.current?.click()}
        >
          Tambah foto
        </button>
        {/* A single text node, so a test's `getByText("2/5 foto")` sees one
            string rather than three adjacent nodes — same rule as the body
            counter in `PostComposer`. */}
        <span className="media-strip-counter">{`${items.length}/${max} foto`}</span>
      </div>

      {/* Below the button that produced it, and `role="alert"` like every other
          failure sentence under src/user — a person who just tapped "Tambah
          foto" and got fewer photos than they picked has to be TOLD, not left
          to infer it from a counter. */}
      {notice !== null ? (
        <p className="media-strip-notice" role="alert">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
