import { z } from "zod";

const email = z.string().trim().toLowerCase().email().max(255);
const password = z.string().min(8).max(200);

export const signupSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email,
  password,
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * `POST /users/signup` — a member/creator's PERSONAL account, distinct from
 * the creator-only `signupSchema` above. `handle` allows up to 31 characters
 * here (not the domain's 30) so a leading `@` a caller pasted in survives
 * validation; `normalizeHandle` strips it before the domain's 3-30 rule
 * (`isValidHandle`) is enforced on the normalised value. The WhatsApp regex
 * is copied FIELD FOR FIELD from `startCheckoutSchema` (tolerant of a
 * leading 0 or +62) so the two forms never disagree about what counts as a
 * valid number.
 */
export const userSignupSchema = z.object({
  handle: z.string().trim().min(1).max(31),
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(255),
  whatsappNumber: z.string().trim().min(8).max(20).regex(/^[+0-9][0-9]{7,19}$/).optional(),
});

export const userLoginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(200),
});

export type UserSignupInput = z.infer<typeof userSignupSchema>;
export type UserLoginInput = z.infer<typeof userLoginSchema>;

/**
 * `PATCH /users/me`. `handle` is deliberately ABSENT — handles are set once
 * (spec §3.2) — so a caller who includes one anyway gets it stripped
 * silently by Zod rather than rejected loudly. That silence is exactly the
 * behaviour that hid a Critical in an earlier phase (a guard checking a
 * field that could never arrive), which is why `users.test.ts` asserts a
 * bare `{ handle: "other" }` patch is a 400 (via the `.refine` below, since
 * stripping it leaves an empty object) AND that the handle never changes —
 * not just that this schema "looks right".
 *
 * `bio` is `nullable().optional()` on purpose: an explicit `null` clears it
 * (present in the patch, so `updateProfile` sets the column to NULL); an
 * absent `bio` leaves it untouched. Those are two different requests and
 * must stay distinguishable all the way down to `DrizzleUserRepository`.
 *
 * An empty or whitespace-only `bio` (after `.trim()`) is normalised to
 * `null` here, via `.transform`, so "no bio" has exactly one representation
 * in the column instead of two (`null` AND `""`). A consumer that renders
 * `bio ?? "Belum ada bio"` would otherwise show a blank instead of the
 * fallback for a bio of `"   "`. This only collapses an empty STRING to
 * null; an explicit `null` and an absent `bio` are untouched by it and stay
 * distinguishable exactly as before.
 *
 * `whatsappNumber` follows the SAME `null`-clears/absent-leaves-alone rule as
 * `bio` — added by the whole-branch review (item 1): the field was writable
 * only once, at signup (`userSignupSchema`), with no way to add it later or
 * fix a typo, which made spec §8's "a wrong address costs them one reset
 * channel and nothing else" false whenever the caller also skipped the
 * number. The regex is copied FIELD FOR FIELD from `userSignupSchema` and
 * `startCheckoutSchema` (tolerant of a leading 0 or +62), so the three forms
 * never disagree about what counts as a valid number. Unlike `bio`, an empty
 * string is NOT collapsed to `null` here — the regex's own `min(8)` already
 * rejects `""` with a normal 400, and a caller that wants to clear the
 * number sends an explicit `null` exactly like clearing a bio.
 */
export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255).optional(),
    bio: z
      .string()
      .trim()
      .max(300)
      .nullable()
      .optional()
      .transform((value) => (value === "" ? null : value)),
    whatsappNumber: z
      .string()
      .trim()
      .min(8)
      .max(20)
      .regex(/^[+0-9][0-9]{7,19}$/)
      .nullable()
      .optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "at least one field is required",
  });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * `POST /users/password-reset/request`. `email` only — no `handle`, no
 * anything else this endpoint could use to confirm an account exists.
 * `.trim()` runs here (whitespace is never meaningful in an email), but
 * deliberately NOT `.toLowerCase()` the way `signupSchema`'s top-level
 * `email` gets — case-folding happens inside `RequestPasswordReset` via
 * `normalizeEmail`, the same split `userSignupSchema` already uses for the
 * same field.
 */
export const requestPasswordResetSchema = z.object({
  email: z.string().trim().email().max(255),
});

export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

/**
 * `POST /users/password-reset/complete`. `token` is the 64-character hex
 * secret from the `/reset/:token` link — bounded generously above the exact
 * 64 chars `mintResetToken` produces (`domain/reset-token.ts`) rather than
 * pinned to it, so a malformed token is a clean 401 from `CompletePasswordReset`
 * (missing/expired/used all answer identically) instead of a 400 that would
 * distinguish "badly formed" from "well formed but wrong" — one MORE shape
 * a caller could use to tell tokens apart. `newPassword` mirrors
 * `userSignupSchema`'s own password rule exactly.
 */
export const completePasswordResetSchema = z.object({
  token: z.string().trim().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

export type CompletePasswordResetInput = z.infer<typeof completePasswordResetSchema>;
