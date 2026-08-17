import { describe, expect, it } from "bun:test";
import { describeRequestFailure } from "./errorCopy";
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
