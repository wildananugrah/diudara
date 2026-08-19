/** 3-30 chars, lowercase letters, digits and underscore. */
export const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;

/** Trim, strip a leading `@` if a caller passed one, lowercase. */
export function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return withoutAt.toLowerCase();
}

export function isValidHandle(normalised: string): boolean {
  return HANDLE_PATTERN.test(normalised);
}

/**
 * Handles nobody may register, because each one is a literal path segment
 * under `/users` and would shadow the parameterised routes beside it — a
 * profile permanently unreachable, and an account that can be followed but
 * never unfollowed.
 *
 * **The list is derived, not invented.** Every entry is a real first segment of
 * a route this app mounts under `/users` that ALSO satisfies `HANDLE_PATTERN`.
 * `routes/users.test.ts` re-derives that set from the running app and fails if
 * a new route escapes this list, so adding `/users/trending` tomorrow breaks a
 * test rather than a person's profile.
 *
 * `me`, `by-handle` and `password-reset` are deliberately ABSENT: 2 characters
 * and hyphens respectively, so `^[a-z0-9_]{3,30}$` already makes all three
 * impossible to register. Listing them would imply a live hazard and invite the
 * next reader to widen the pattern to match.
 *
 * Nothing outside `/users` needs reserving. Web profile URLs are `/@handle`
 * (`App.tsx` — the route is `/:handleParam` and `ProfilePage` 404s a param
 * without a leading `@`), so a handle can never shadow `/beranda`, `/masuk` or
 * `/dashboard`.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "explore",
  "feed",
  "limits",
  "login",
  "media",
  "posts",
  "signup",
]);

/** Answers about an ALREADY NORMALISED handle, like `isValidHandle` — `@Posts` is the reserved `posts` only after `normalizeHandle`. */
export function isReservedHandle(normalised: string): boolean {
  return RESERVED_HANDLES.has(normalised);
}
