/** Bytes plus what the delivery route must send with them. */
export interface MediaObject {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Where image bytes live. Two objects per image — see the spec's §4 for the key
 * layout. Callers pass a media id and a variant; **no caller ever composes a
 * bucket key or a URL**, which is what keeps §5.1 true by construction.
 */
export interface MediaStoragePort {
  put(id: string, variant: "full" | "thumb", bytes: Uint8Array): Promise<void>;
  /** `null` when the object is not there — a media row whose bytes are missing must 404, not 500. */
  get(id: string, variant: "full" | "thumb"): Promise<MediaObject | null>;
  /** Idempotent: removing an absent object is a no-op, matching `softDelete` on posts. */
  remove(id: string): Promise<void>;
}
