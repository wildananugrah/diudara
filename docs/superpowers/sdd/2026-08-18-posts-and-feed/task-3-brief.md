## Task 3: The relative-time formatter and `PostCard`

**Files:**
- Create: `apps/web/src/user/relativeTime.ts` + `relativeTime.test.ts`
- Create: `apps/web/src/user/PostCard.tsx` + `PostCard.test.tsx`
- Modify: `apps/web/src/styles.css` (additive only)

**Interfaces:**
- Consumes: nothing from earlier tasks except the `PostView` shape, which Task 5 adds to `apiClient`. **Declare `PostView` in `apiClient.ts` as part of THIS task** so `PostCard` can import it: `export interface PostView { id: string; body: string; createdAt: string; editedAt: string | null; author: { handle: string; displayName: string } }`.
- Produces: `formatRelativeTime(iso: string, now: Date): string`; `PostCard` with props `{ post: PostView; isOwn: boolean; now?: Date; onEdit?: (post: PostView) => void; onDeleted?: (id: string) => void }`. **`onDeleted` takes the id, not the post** — the row is gone, and the caller only needs to know which one.

**There is no relative-time formatter anywhere in this repo** — searched for `timeAgo`,
`formatRelative`, `Intl.RelativeTimeFormat`, `dayjs`, `date-fns`; nothing. You are writing the first
one. Every existing screen leaves timestamps as raw ISO strings.

- [ ] **Step 1: Write the failing formatter test**

Create `apps/web/src/user/relativeTime.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { formatRelativeTime } from "./relativeTime";

const NOW = new Date("2026-08-18T12:00:00.000Z");

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it('reads "baru saja" under a minute', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe("baru saja");
    expect(formatRelativeTime(ago(59 * SECOND), NOW)).toBe("baru saja");
  });

  it("switches to minutes at exactly one minute", () => {
    expect(formatRelativeTime(ago(MINUTE), NOW)).toBe("1m");
    expect(formatRelativeTime(ago(59 * MINUTE), NOW)).toBe("59m");
  });

  it("switches to hours at exactly one hour", () => {
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe("1j");
    expect(formatRelativeTime(ago(23 * HOUR), NOW)).toBe("23j");
  });

  it("switches to days at exactly one day", () => {
    expect(formatRelativeTime(ago(DAY), NOW)).toBe("1h");
    expect(formatRelativeTime(ago(6 * DAY), NOW)).toBe("6h");
  });

  it("switches to an absolute Indonesian date at seven days", () => {
    expect(formatRelativeTime(ago(7 * DAY), NOW)).toBe("11 Agu 2026");
  });

  it('treats a future timestamp as "baru saja" rather than negative', () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + HOUR).toISOString(), NOW)).toBe("baru saja");
  });

  it("returns an empty string for an unparseable value rather than NaN", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBe("");
  });
});
```

- [ ] **Step 2: Run it, watch it fail, then write the formatter**

Create `apps/web/src/user/relativeTime.ts`:

```ts
/**
 * "2j", "3h", "11 Agu 2026" — Bahasa Indonesia, from an ISO string.
 *
 * `now` IS A PARAMETER, not `Date.now()`. This project has a family of a dozen
 * flakes that are all a clock read on one side compared against a clock read on
 * the other, and they fire under CPU contention. A formatter that reads the
 * clock itself cannot be tested at a boundary at all.
 *
 * MONTH NAMES ARE A LITERAL ARRAY, not `Intl.DateTimeFormat("id-ID")`. A Bun or
 * Node build without full ICU silently falls back to English, which would make
 * this pass locally and print "Aug" in production.
 */
const MONTHS_ID = [
  "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
  "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function formatRelativeTime(iso: string, now: Date): string {
  const then = new Date(iso);
  const at = then.getTime();
  if (Number.isNaN(at)) return "";

  const elapsed = now.getTime() - at;
  // A clock ahead of the server's is a skew, not a post from the future.
  if (elapsed < MINUTE) return "baru saja";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}j`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}h`;

  return `${then.getUTCDate()} ${MONTHS_ID[then.getUTCMonth()]} ${then.getUTCFullYear()}`;
}
```

- [ ] **Step 3: Write the failing `PostCard` test**

Create `apps/web/src/user/PostCard.test.tsx`. Follow `FollowButton.test.tsx`'s idiom:
`@testing-library/react`, `MemoryRouter`, `afterEach(cleanup)`, and **no module mocking**.

Cover:
- the display name, `@handle` and body all render
- the handle links to `/@handle`
- `· diedit` is **absent** when `editedAt` is null and **present** when it is set
- `isOwn: false` renders **no** `Edit` and no `Hapus` control
- `isOwn: true` renders both, and clicking each calls the matching callback with the post
- the relative time renders (pass a fixed `now` prop, or inject the clock — your choice, but it must
  be injectable; a card that reads `Date.now()` cannot be tested at a boundary)
- **no follow button is rendered at all**, and `PostCard`'s props contain no `viewerFollows` — assert
  this by scanning the source file for the string `viewerFollows`, the way
  `FollowButton.test.tsx` scans source. Phase 2's carry-forward names this card as exactly where
  `viewerFollows` gets guessed again as `signedIn ? false : null`.

- [ ] **Step 4: Write `PostCard`**

Keep it under 90 lines. Body text must preserve line breaks (`white-space: pre-wrap` in
`styles.css`) and must **never** be rendered with `dangerouslySetInnerHTML`. Add only additive CSS.

- [ ] **Step 5: Run the suite, then prove the card by mutation**

- Remove the `editedAt !== null` condition so `diedit` always renders → red.
- Remove the `isOwn` condition on the menu → red.
- Change `formatRelativeTime`'s `WEEK` boundary to `6 * DAY` → red.

Restore each; paste the outputs.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): relative time in Bahasa, and PostCard"
```

---

