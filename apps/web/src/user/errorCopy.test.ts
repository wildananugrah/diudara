import { describe, expect, it } from "bun:test";
import { describeRequestFailure, describeSubscribeFailure, describeUploadFailure } from "./errorCopy";
import { SESSION_EXPIRED_MESSAGE, UserApiError } from "./apiClient";

/**
 * Re-review N1. The one path a failed request becomes readable text through —
 * see `errorCopy.ts`'s own docstring for the four rounds that fixed this same
 * defect one file at a time.
 *
 * Every sentence below is asserted as a LITERAL, never as the constant the
 * implementation reads, for the reason this project has now recorded three
 * times: an assertion against the same symbol the production code uses moves in
 * lockstep with any regression to it and passes vacuously.
 */
describe("describeRequestFailure", () => {
  it("answers a network failure — the one that produced the browser's own 'Failed to fetch'", () => {
    // Exactly what `fetch` rejects with when the connection drops: a TypeError,
    // not a UserApiError, so there is no status to reason about.
    expect(describeRequestFailure(new TypeError("Failed to fetch"))).toBe(
      "Tidak dapat menghubungi server. Coba lagi."
    );
  });

  it("answers a 500 — the one that produced 'internal server error'", () => {
    expect(describeRequestFailure(new UserApiError("internal server error", 500))).toBe(
      "Server sedang bermasalah. Coba lagi sebentar lagi."
    );
  });

  it("answers a 404 in Bahasa, never the API's English 'user not found'", () => {
    expect(describeRequestFailure(new UserApiError("user not found", 404))).toBe(
      "Data yang Anda cari tidak ditemukan."
    );
  });

  it("answers a 400 in Bahasa, never Zod's English sentence", () => {
    const zod = "invalid query: q must be at most 100 characters, limit must be an integer between 1 and 100";
    expect(describeRequestFailure(new UserApiError(zod, 400))).toBe(
      "Permintaan tidak dapat diproses. Coba lagi."
    );
  });

  it("answers a 429", () => {
    expect(describeRequestFailure(new UserApiError("too many requests", 429))).toBe(
      "Terlalu banyak permintaan. Coba lagi sebentar lagi."
    );
  });

  it("answers a 409", () => {
    expect(describeRequestFailure(new UserApiError("tidak bisa mengikuti akun sendiri", 409))).toBe(
      "Permintaan tidak dapat diproses. Coba lagi."
    );
  });

  /**
   * The single exception, and it is not an exception to the rule: a 401's
   * message is authored by THIS codebase (`apiRequest` throws
   * `SESSION_EXPIRED_MESSAGE` after clearing the session), not lifted off the
   * wire, and it is already Bahasa.
   */
  it("answers a 401 with the client's own session-expired copy", () => {
    expect(describeRequestFailure(new UserApiError(SESSION_EXPIRED_MESSAGE, 401))).toBe(
      "Sesi Anda sudah berakhir. Silakan masuk kembali."
    );
  });

  it("survives a non-Error thrown value without throwing itself", () => {
    // `catch` binds whatever was thrown, and nothing guarantees it is an Error.
    expect(describeRequestFailure("a bare string")).toBe(
      "Tidak dapat menghubungi server. Coba lagi."
    );
    expect(describeRequestFailure(null)).toBe("Tidak dapat menghubungi server. Coba lagi.");
    expect(describeRequestFailure(undefined)).toBe("Tidak dapat menghubungi server. Coba lagi.");
  });

  /**
   * THE INVARIANT, stated once over every branch rather than once per case: the
   * server's text never comes back out, whatever it says and whatever status it
   * arrived with. A future branch added without thinking would have to pass
   * this too.
   */
  it("NEVER returns the message it was given, at any status", () => {
    const smuggled = "SMUGGLED-SERVER-TEXT";
    const statuses = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503];

    for (const status of statuses) {
      const copy = describeRequestFailure(new UserApiError(smuggled, status));
      expect(`${status}: ${copy.includes(smuggled)}`).toBe(`${status}: false`);
    }
    expect(describeRequestFailure(new Error(smuggled)).includes(smuggled)).toBe(false);
  });

  /**
   * "All copy in Bahasa Indonesia" is a binding ledger ruling, and the defect
   * this module exists to stop was English reaching a user. A cheap structural
   * check across every branch: no ASCII-only English marker word, and the
   * sentence ends like a sentence.
   */
  it("every branch answers in Bahasa Indonesia", () => {
    const english = /\b(the|server error|not found|failed|invalid|request|please|try again)\b/i;
    const samples = [
      describeRequestFailure(new TypeError("Failed to fetch")),
      ...[400, 401, 404, 429, 500].map((s) => describeRequestFailure(new UserApiError("x", s))),
    ];

    for (const copy of samples) {
      expect(`${copy} -> english:${english.test(copy)}`).toBe(`${copy} -> english:false`);
      expect(copy.endsWith(".")).toBe(true);
    }
  });
});

/**
 * Fix round 1, Important 1. `describeRequestFailure` collapses EVERY 4xx into
 * "Permintaan tidak dapat diproses. Coba lagi." — which is unactionable for the
 * two upload failures an Indonesian phone actually produces: a photo over the
 * size limit, and **HEIC**, the default format of every iPhone camera. Both are
 * plain 400s, so both were told to try again, and retrying cannot fix either.
 *
 * The size case is refused locally before any request (see `PostComposer`'s
 * `attachFiles`), so a 400 that reaches HERE is the bytes not being a supported
 * image. The sentence is chosen by the SHAPE of the failure — status 400 from
 * the upload route — and is authored here, never lifted off the wire, which is
 * exactly what `src/test/no-raw-server-errors.test.ts` requires.
 */
describe("describeUploadFailure", () => {
  it("names the format problem, and names HEIC — the case a phone actually hits", () => {
    expect(
      describeUploadFailure(
        new UserApiError(
          "Format foto tidak didukung. Gunakan JPG, PNG, atau WebP.",
          400,
          {},
          "media_unsupported_format"
        )
      )
    ).toBe("Format ini tidak didukung. Gunakan JPG, PNG, atau WebP — foto iPhone (HEIC) belum didukung.");
  });

  it("does not lift the server's own sentence, even when the server's sentence is Bahasa too", () => {
    // The API answers Bahasa here, which makes this the easiest place in the
    // codebase to justify rendering `err.message`. The rule is not "English is
    // banned", it is that a screen never prints what the wire sent.
    const answered = describeUploadFailure(
      new UserApiError(
        "Format foto tidak didukung. Gunakan JPG, PNG, atau WebP.",
        400,
        {},
        "media_unsupported_format"
      )
    );
    expect(answered.includes("Format foto tidak didukung")).toBe(false);
  });

  /**
   * **The reason is READ off the wire now, not inferred from the status.**
   * Final whole-branch review: while `POST /users/media` had exactly three 400s
   * and two of them were unreachable, "any 400 here is a format problem" was
   * true. The pixel bound is a fourth, and telling somebody whose photo is
   * simply too high-resolution that iPhone HEIC is unsupported is confidently
   * wrong rather than merely vague.
   *
   * The codes are LITERALS here, as they are on the API side — they are a wire
   * contract, and a rename that changed what travels must redden something.
   */
  it("tells somebody with a 45-megapixel photo what is actually wrong", () => {
    expect(
      describeUploadFailure(new UserApiError("x", 400, {}, "media_too_many_pixels"))
    ).toBe("Resolusi foto terlalu besar. Perkecil ukuran foto lalu unggah ulang.");
  });

  it("tells somebody with an over-size file to pick a smaller one", () => {
    expect(describeUploadFailure(new UserApiError("x", 400, {}, "media_too_large"))).toBe(
      "Foto terlalu besar. Pilih foto berukuran di bawah 10 MB."
    );
  });

  /**
   * **THE 413 NOBODY ENUMERATED.** nginx's default `client_max_body_size` is
   * 1 MB and an ordinary phone photo is 2–5 MB, so on a box whose proxy has not
   * been configured (see CONTRIBUTING.md's "Deployment") the request never
   * reaches the API at all: nginx answers 413 with its own HTML error page,
   * which carries no `code` and is not even JSON. Before this branch that
   * became "Permintaan tidak dapat diproses. Coba lagi." — the retry-forever
   * loop this module exists to kill, reintroduced through a status code.
   *
   * The API answers 413 too, from `bodyLimit`, for the same reason — so one
   * branch covers both.
   */
  it("answers a 413 with something actionable, whoever sent it", () => {
    expect(describeUploadFailure(new UserApiError("permintaan gagal (413)", 413))).toBe(
      "Foto terlalu besar. Pilih foto berukuran di bawah 10 MB."
    );
  });

  it("does not guess when a 400 arrives with no code at all", () => {
    // An older API in a deploy skew, or a refusal nobody has labelled yet.
    // Vague is the honest answer; a confidently wrong one is not.
    expect(describeUploadFailure(new UserApiError("x", 400))).toBe(
      "Permintaan tidak dapat diproses. Coba lagi."
    );
  });

  it("delegates a 500 to describeRequestFailure — an upload CAN be retried after one", () => {
    expect(describeUploadFailure(new UserApiError("internal server error", 500))).toBe(
      "Server sedang bermasalah. Coba lagi sebentar lagi."
    );
  });

  it("delegates a network failure", () => {
    expect(describeUploadFailure(new TypeError("Failed to fetch"))).toBe(
      "Tidak dapat menghubungi server. Coba lagi."
    );
  });

  it("delegates a 401 to the session sentence", () => {
    expect(describeUploadFailure(new UserApiError("invalid or expired token", 401))).toBe(
      SESSION_EXPIRED_MESSAGE
    );
  });

  it("delegates a 429 rather than claiming it is a format problem", () => {
    expect(describeUploadFailure(new UserApiError("too many requests", 429))).toBe(
      "Terlalu banyak permintaan. Coba lagi sebentar lagi."
    );
  });

  it("answers in Bahasa on every branch", () => {
    const english = /\b(the|server error|not found|failed|invalid|request|please|try again)\b/i;
    const samples = [
      describeUploadFailure(new TypeError("Failed to fetch")),
      ...[400, 401, 404, 413, 429, 500].map((s) => describeUploadFailure(new UserApiError("x", s))),
      ...["media_missing_file", "media_too_large", "media_too_many_pixels", "media_unsupported_format"].map(
        (code) => describeUploadFailure(new UserApiError("x", 400, {}, code))
      ),
    ];

    for (const copy of samples) {
      expect(`${copy} -> english:${english.test(copy)}`).toBe(`${copy} -> english:false`);
      expect(copy.endsWith(".")).toBe(true);
    }
  });
});

/**
 * Task 10 of Phase 5a. A failed "Jadi anggota" needs ONE distinction the
 * general sentence cannot make, and it is the same distinction
 * `describeUploadFailure` exists for: a refusal that a retry cannot fix must
 * not be answered "coba lagi".
 *
 * `POST /users/:handle/subscribe` answers 409 for SEVEN different refusals and
 * carries no machine-readable `code` for any of them — see the function's own
 * docstring for the list. Six cannot be fixed by pressing again and one can,
 * so the sentence promises nothing about pressing again at all: it names the
 * REACHABLE possibilities and points at the page rather than at the button.
 *
 * "A membership that has ended, with no renewal" WAS on that list and is not
 * any more (the final whole-branch review's C-1): Phase 5b retires the lapsed
 * row inside the purchase transaction, so an ordinary lapsed member is no
 * longer refused at all — they buy. Leaving the clause in would have told a
 * buyer that a feature this branch shipped does not exist.
 */
describe("describeSubscribeFailure", () => {
  it("answers a 409 with a remedy that is not 'try again'", () => {
    const server =
      "Anda sudah menjadi anggota aktif kreator ini. Membayar lagi tidak menambah masa aktif.";
    expect(describeSubscribeFailure(new UserApiError(server, 409))).toBe(
      "Keanggotaan ini belum bisa dibeli sekarang — tingkatannya mungkin sudah ditutup, " +
        "kreatornya belum siap menerima pembayaran, pembayaran sebelumnya masih diproses, " +
        "atau Anda masih menjadi anggota aktif kreator ini. Muat ulang halaman ini untuk " +
        "melihat keadaan terbaru."
    );
  });

  /**
   * **THE LOOP, PINNED SHUT — AND THE DEAD COPY, PINNED OUT.** The sentence
   * before 5a's fix advised reloading "untuk melihat penawaran terbaru", which
   * re-rendered the very same refused button; the sentence 5a replaced it with
   * then named "perpanjangan belum tersedia", which Phase 5b made false. A
   * lapsed member is not refused by this route any more — `retireExpired` runs
   * inside the purchase transaction — so telling them renewal is unavailable
   * would be the product denying its own headline feature.
   */
  it("promises no fresh offer, and no longer claims renewal is unavailable", () => {
    const copy = describeSubscribeFailure(new UserApiError("apa pun", 409));

    expect(copy.includes("penawaran terbaru")).toBe(false);
    expect(copy.includes("coba lagi")).toBe(false);
    expect(copy.includes("Coba lagi")).toBe(false);
    // The clause 5b made untrue, gone — in either casing.
    expect(copy.toLowerCase().includes("perpanjangan belum tersedia")).toBe(false);
    // ...and what it names instead is a refusal that IS still reachable: a
    // viewer who already holds a live membership.
    expect(copy.includes("masih menjadi anggota aktif")).toBe(true);
  });

  it("never repeats what the server sent, even though this route's 409 is already Bahasa", () => {
    const server =
      "Anda sudah menjadi anggota aktif kreator ini. Membayar lagi tidak menambah masa aktif.";
    const copy = describeSubscribeFailure(new UserApiError(server, 409));

    // The rule is not "English is banned"; it is that a screen never prints
    // what the wire sent — see `no-raw-server-errors.test.ts`.
    expect(copy.includes("Membayar lagi tidak menambah masa aktif")).toBe(false);
  });

  it("delegates every other shape unchanged — a 500", () => {
    expect(describeSubscribeFailure(new UserApiError("internal server error", 500))).toBe(
      "Server sedang bermasalah. Coba lagi sebentar lagi."
    );
  });

  it("delegates a dropped connection, which is not a UserApiError at all", () => {
    expect(describeSubscribeFailure(new TypeError("Failed to fetch"))).toBe(
      "Tidak dapat menghubungi server. Coba lagi."
    );
  });

  it("delegates the 401, whose message this codebase authored and which is already Bahasa", () => {
    expect(describeSubscribeFailure(new UserApiError("ignored", 401))).toBe(SESSION_EXPIRED_MESSAGE);
  });
});
