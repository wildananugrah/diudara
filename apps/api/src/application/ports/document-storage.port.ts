/**
 * Where document bytes live. ONE object per document, stored byte-for-byte as
 * uploaded — no variants, no transcoding.
 *
 * **A separate port from `MediaStoragePort`, not a widening of it.** That one
 * is `put(id, variant: "full" | "thumb", bytes)` keyed `posts/${id}/${variant}.webp`
 * — a shape that encodes "two derived variants of a re-encoded image". A third
 * variant would make its `remove(id)` mean two different things depending on
 * what kind of id it was handed.
 *
 * **No content type anywhere in this interface.** It lives on the
 * `community_document` row, which the delivery route has to read anyway to
 * check the community and the member gate — so the type arrives free with a
 * lookup that was already happening, and this port never has to be told or
 * asked.
 *
 * **No caller ever composes a bucket key or a URL**, the rule that keeps a
 * bucket URL structurally unable to reach a response — the same guarantee
 * `MediaStoragePort` documents.
 */
export interface DocumentStoragePort {
  put(id: string, bytes: Uint8Array): Promise<void>;
  /** `null` when the object is not there — a row whose bytes are missing must 404, not 500. */
  get(id: string): Promise<Uint8Array | null>;
  /** Idempotent: removing an absent object is a no-op. */
  remove(id: string): Promise<void>;
}
