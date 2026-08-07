const MAX_SLUG_LENGTH = 120;
const FALLBACK_SLUG = "komunitas";

export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    // NFKD splits an accented letter into a base letter plus a combining mark.
    // Drop the marks here — otherwise the [^a-z0-9] pass below turns each one
    // into a hyphen, so "Ñoño" becomes "n-on-o" instead of "nono". A diacritic
    // at the end of a word hides this, because the trailing hyphen gets
    // stripped; only mid-word accents expose it.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (base.length === 0) {
    return FALLBACK_SLUG;
  }

  return base.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
}

/**
 * Finds a free slug by appending an incrementing suffix.
 * `taken` reports whether a candidate is already in use.
 */
export async function resolveSlugCollision(
  base: string,
  taken: (candidate: string) => Promise<boolean>
): Promise<string> {
  if (!(await taken(base))) {
    return base;
  }

  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!(await taken(candidate))) {
      return candidate;
    }
  }

  throw new Error(`could not find a free slug for "${base}" after 1000 attempts`);
}
