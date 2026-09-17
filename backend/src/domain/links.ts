/**
 * Validation for creator-supplied external links.
 *
 * These URLs end up in `href`/`src` attributes on a page other members load, so
 * the scheme is the thing that matters: `javascript:` and `data:` URLs are how a
 * pasted "link" turns into script execution in someone else's browser. Only
 * http(s) is ever allowed through.
 */

const SAFE_SCHEMES = new Set(["http:", "https:"]);

/**
 * Returns the normalised URL, or null if it is not a usable http(s) address.
 * A missing scheme is assumed to be https rather than rejected, since creators
 * routinely paste bare hostnames.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  const input = raw?.trim();
  if (!input) return null;

  // Reject a dangerous scheme before the https:// guess can mask it — without
  // this, "javascript:alert(1)" would become "https://javascript:alert(1)".
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^https?:\/\//i.test(input)) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }

  if (!SAFE_SCHEMES.has(url.protocol)) return null;
  // A URL with no host ("https:///path") is not reachable by anyone.
  if (!url.hostname || !url.hostname.includes(".")) return null;

  return url.toString();
}
