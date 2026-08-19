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
 * Named once and used by two branches — the byte cap and the proxy's 413 are
 * the same problem to the person holding the phone. The limit is written as
 * "10 MB" rather than interpolated from `MAX_UPLOAD_BYTES`: this file is
 * asserted against literals, and a sentence assembled from the constant it
 * describes cannot redden when that constant moves.
 */
const TOO_LARGE = "Foto terlalu besar. Pilih foto berukuran di bawah 10 MB.";

/**
 * **A failed PHOTO UPLOAD, which needs one distinction the general sentence
 * cannot make.**
 *
 * Fix round 1, Important 1. `describeRequestFailure` answers every 4xx with
 * "Permintaan tidak dapat diproses. Coba lagi." — deliberately vague, and right
 * for the routes it was written for. It is wrong here, because the upload
 * failures an Indonesian phone actually produces are all refusals that a retry
 * cannot fix — the person has to do something different:
 *
 * | failure | what the person must do |
 * |---|---|
 * | over the size limit | pick a smaller photo — refused LOCALLY first, and by nginx's `client_max_body_size` or the API's `bodyLimit` as a 413 |
 * | too many PIXELS | a small file holding an enormous picture — downscale it |
 * | **HEIC** (every iPhone's default) | export or re-save as JPG |
 *
 * Telling somebody with an iPhone photo to "coba lagi" sends them round a loop
 * that cannot terminate, and spec §9 already names HEIC as the first thing this
 * phase will have to revisit — an undiagnosable failure is the worst possible
 * state for it to be in when that happens.
 *
 * **THE SHAPE IS NOW READ, NOT INFERRED.** This used to reason "a 400 from
 * `POST /users/media` can only be an unsupported format", which was true while
 * that route had exactly three 400s and two of them were unreachable. The final
 * whole-branch review's pixel bound is a fourth, and a proxy's 413 a fifth
 * failure mode — so the inference would have told somebody whose photo is
 * merely too high-resolution that iPhone HEIC is unsupported, which is worse
 * than vague. The API now sends a machine-readable `code`
 * (`UPLOAD_ERROR_CODE` in `@diudara/shared`) and this function branches on it,
 * falling back to the general sentence whenever there is no code to read.
 *
 * Nothing is read off `err.message` — see
 * `src/test/no-raw-server-errors.test.ts`, and note that the API's own sentence
 * here is BAHASA, which makes this the easiest place in the codebase to justify
 * printing the wire's text. The rule is not "English is banned"; it is that a
 * screen never prints what the wire sent. A `code` is not the wire's text: it
 * is never displayed, only matched.
 *
 * Every other shape — 401, 429, 5xx, a dropped connection — is delegated
 * unchanged, because for those "coba lagi" is genuinely the right advice.
 */
export function describeUploadFailure(err: unknown): string {
  if (!(err instanceof UserApiError)) return describeRequestFailure(err);

  // 413 FIRST, and it is matched on the STATUS because the most likely sender
  // of one is not this API. nginx's default `client_max_body_size` is 1 MB
  // against an API that accepts 10 and a phone camera that produces 2–5, so on
  // a box whose proxy has not been configured the request is refused by the
  // proxy, with its own HTML error page: no `code`, not even JSON. The API's
  // own `bodyLimit` answers 413 for the same reason, so one branch serves both.
  if (err.status === 413) return TOO_LARGE;

  switch (err.code) {
    case "media_too_large":
      return TOO_LARGE;
    case "media_too_many_pixels":
      // NOT the same sentence as the byte cap. The person satisfied that one —
      // their file is small; it is the picture inside it that is enormous — and
      // telling them to "pick a smaller file" would send them looking for a
      // property their file already has.
      return "Resolusi foto terlalu besar. Perkecil ukuran foto lalu unggah ulang.";
    case "media_unsupported_format":
      // Names the formats that DO work rather than only the one that does not:
      // mirrors the API's own reasoning in `domain/image.ts`, whose message says
      // "Gunakan JPG, PNG, atau WebP" for the same reason.
      return "Format ini tidak didukung. Gunakan JPG, PNG, atau WebP — foto iPhone (HEIC) belum didukung.";
    default:
      // Includes `media_missing_file`, which no client of this API can provoke,
      // and — importantly — every UNLABELLED 4xx. Guessing here is what this
      // rewrite removed: vague is honest, confidently wrong is not.
      return describeRequestFailure(err);
  }
}
