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
