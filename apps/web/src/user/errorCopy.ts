import { SESSION_EXPIRED_MESSAGE, UserApiError } from "./apiClient";

/**
 * **THE one place a failed request becomes something a user reads.**
 *
 * Re-review N1. Three separate rounds fixed this same defect in three separate
 * files and each time closed the INSTANCE, not the class: item 5 fixed Jelajah,
 * item 7 fixed the follow button, and `FollowListPage`/`ProfilePage` were still
 * printing the server's raw string afterwards — in a file this project's own fix
 * round had edited twice. Measured on the real components:
 *
 *     "Gagal memuat daftar" + "internal server error"    (a 500)
 *     "Gagal memuat profil" + "Failed to fetch"          (a network drop)
 *
 * The mechanism was always the same one line, `err instanceof Error ?
 * err.message : "..."`, and the reason it kept coming back is that nothing
 * stopped it. `src/test/no-raw-server-errors.test.ts` is that something; this
 * module is what it points people at.
 *
 * **The sentence is chosen from the SHAPE of the failure, never from its text.**
 * That is the whole idea. `readError` lifts the API's `{ error }` body verbatim
 * into `UserApiError.message`, and those strings are not translated and were
 * never written for a user: `routes/users.ts` answers `"user not found"` and
 * `"invalid or expired token"` in English, Zod produces `"invalid query: q must
 * be at most 100 characters, ..."`, and a network failure is not a
 * `UserApiError` at all — `fetch` rejects with a `TypeError` whose message is
 * the browser's own `"Failed to fetch"`. None of that can be made Bahasa by
 * being careful at the call site, which is why the call sites no longer get to
 * decide.
 *
 * Nothing is lost by discarding the text. The only failures with a specific
 * remedy are the 401 (sign in again, which `SESSION_EXPIRED_MESSAGE` already
 * says in Bahasa, and which `FollowButton` acts on by navigating) and a 400
 * carrying `fieldErrors`, which forms render per-field from
 * `UserApiError.fieldErrors` rather than from the message.
 *
 * Callers add their own context sentence — "Gagal memuat profil", "Pencarian
 * gagal" — and append this. Both halves are then Bahasa.
 */
export function describeRequestFailure(err: unknown): string {
  if (!(err instanceof UserApiError)) {
    // A `TypeError: Failed to fetch`, a DNS failure, an aborted request, an
    // offline phone. Not a server response at all, so there is no status to
    // reason about — and this is the exact sentence four other screens in this
    // directory already used for it, kept identical rather than invented anew.
    return "Tidak dapat menghubungi server. Coba lagi.";
  }
  if (err.status === 401) {
    // Client-authored and already Bahasa — see its own docstring. The one case
    // where the message on the error IS the right thing to show.
    return SESSION_EXPIRED_MESSAGE;
  }
  if (err.status === 404) {
    return "Data yang Anda cari tidak ditemukan.";
  }
  if (err.status === 429) {
    return "Terlalu banyak permintaan. Coba lagi sebentar lagi.";
  }
  if (err.status >= 500) {
    return "Server sedang bermasalah. Coba lagi sebentar lagi.";
  }
  // Every other 4xx. Deliberately vague: a 400 whose per-field detail matters is
  // already rendered from `fieldErrors`, and a 409 here means the client asked
  // for something the server will not do, which the user cannot act on beyond
  // trying again.
  return "Permintaan tidak dapat diproses. Coba lagi.";
}

/**
 * **A failed PHOTO UPLOAD, which needs one distinction the general sentence
 * cannot make.**
 *
 * Fix round 1, Important 1. `describeRequestFailure` answers every 4xx with
 * "Permintaan tidak dapat diproses. Coba lagi." — deliberately vague, and right
 * for the routes it was written for. It is wrong here, because the two upload
 * failures an Indonesian phone actually produces are both plain 400s and
 * NEITHER can be fixed by trying again:
 *
 * | failure | what the person must do |
 * |---|---|
 * | over the size limit | pick a smaller photo — refused LOCALLY now, before any request |
 * | **HEIC** (every iPhone's default) | export or re-save as JPG |
 *
 * Telling somebody with an iPhone photo to "coba lagi" sends them round a loop
 * that cannot terminate, and spec §9 already names HEIC as the first thing this
 * phase will have to revisit — an undiagnosable failure is the worst possible
 * state for it to be in when that happens.
 *
 * **The sentence is still chosen by the SHAPE of the failure and authored
 * here.** The shape is "a 400 from `POST /users/media`": that route's only
 * other 400s are a missing file (`uploadMedia` always sends one) and the size
 * limit (`PostComposer` refuses those locally against the same
 * `MAX_UPLOAD_BYTES` the API enforces), so what is left is bytes that are not a
 * supported image. Nothing is read off `err.message` — see
 * `src/test/no-raw-server-errors.test.ts`, and note that the API's own sentence
 * here is BAHASA, which makes this the easiest place in the codebase to justify
 * printing the wire's text. The rule is not "English is banned"; it is that a
 * screen never prints what the wire sent.
 *
 * Every other shape — 401, 429, 5xx, a dropped connection — is delegated
 * unchanged, because for those "coba lagi" is genuinely the right advice.
 */
export function describeUploadFailure(err: unknown): string {
  if (err instanceof UserApiError && err.status === 400) {
    // Names the formats that DO work rather than only the one that does not:
    // mirrors the API's own reasoning in `domain/image.ts`, whose message says
    // "Gunakan JPG, PNG, atau WebP" for the same reason.
    return "Format ini tidak didukung. Gunakan JPG, PNG, atau WebP — foto iPhone (HEIC) belum didukung.";
  }
  return describeRequestFailure(err);
}
