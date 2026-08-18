# Task 7 report — Repairing the split session

**Commit:** `e2b3a44` on branch `main` (parent `015a26a`).
**Files changed:** `apps/web/src/user/apiClient.ts`, `apps/web/src/user/apiClient.test.ts`,
`apps/web/src/App.tsx`, `apps/web/src/App.test.tsx`. Nothing else.

## Disclosure: implementation was written before its test

For Steps 1 and 3 I wrote `apiClient.ts`'s implementation (dropping `id` from `SessionUser`,
adding `repairSplitSession`) and `App.tsx`'s `useEffect` wiring **before** writing the
corresponding tests — I transcribed the brief's given code directly rather than starting from a
red test. To still get a legitimate red phase, I copied the finished implementation files aside,
`git checkout --`ed the two implementation files back to `015a26a` (keeping the new tests in
place), ran the suite to confirm a real failure for the right reason, then restored the
implementation from the saved copies and diffed it byte-for-byte against the restored file to
confirm no drift. That sequence and its output is Step-1/2's "red phase" section below. Step 4's
App-level test was written, watched red by temporarily removing the `useEffect` (not before
writing the effect the first time), then confirmed green again — that part follows the intended
order. The mutation testing in Step 5 was done properly throughout (mutate → observe red → revert
→ confirm restored).

## Step 1 — drop `id` from `SessionUser`

Verified per the brief's instructions: `grep -rn "\.id" apps/web/src/user | grep -i session`
returned nothing, and `FollowButton.tsx:99`, `BerandaPage.tsx:61`, `ProfilePage.tsx:67` all read
only `.handle` off `getSessionUser()`. `GET /users/me`'s `OwnUserProfile` (`apiClient.ts:445-448`)
extends `UserProfileCore` (`handle`, `displayName`, `bio`, `createdAt`) plus `email` and
`whatsappNumber` — no `id`, confirming the field could never be rebuilt from that endpoint.

Changes in `apps/web/src/user/apiClient.ts`:
- `SessionUser` (line ~25): removed `id: string`.
- `getSessionUser()` (line ~89): destructures and validates only `handle`, `displayName`, `email`;
  returns exactly those three. An extra `id` key in a stored blob is now silently ignored rather
  than validated.
- No login/signup call site needed editing — `login()` (line 348) is the only production
  constructor of a session and it forwards `result.user` from the server response verbatim; it
  never names `id` explicitly.

Test changes in `apps/web/src/user/apiClient.test.ts`:
- Added `SESSION_USER` (the `USER` fixture minus `id`) next to the existing `USER` constant, with
  a docstring explaining why `USER` itself keeps `id` (it's a variable, not a literal, so no
  excess-property check fires when passed to `setUserSession`).
- Updated the three existing `expect(getSessionUser()).toEqual(USER)` assertions (in "round-trips
  the cached account", "isUserSignedIn reads the TOKEN key — false with a cached account and no
  token", and "stores the session on a successful login") to `toEqual(SESSION_USER)` — a real
  behavior change, not fixture churn: `getSessionUser()` no longer returns `id`.
- Added a new test in the `session storage` describe block, pinning Step 1's exact requirement:

  ```ts
  it("still parses a stored blob that contains an id key from an older build", () => {
    localStorage.setItem(USER_TOKEN_STORAGE_KEY, "jwt-abc");
    localStorage.setItem(
      "diudara.user.account",
      JSON.stringify({ id: "user-1", handle: "wildan", displayName: "Wildan", email: "wildan@example.com" })
    );
    expect(getSessionUser()).toEqual(SESSION_USER);
  });
  ```

## Step 2 — `repairSplitSession`'s failing tests (as far as they went before I wrote the implementation)

Added a `describe("repairSplitSession", ...)` block in `apiClient.test.ts` (before `describe("apiFetch (authenticated)")`)
with the four tests the brief specifies:

1. `"rebuilds the account blob when a token is present and the account is missing"` — writes only
   `USER_TOKEN_STORAGE_KEY`, mocks `fetch` to answer the `/users/me` shape, calls
   `repairSplitSession()`, asserts `calls.length === 1`, `calls[0].url === "/users/me"`, the
   `Authorization` header carries the token, `getSessionUser()` is non-null with `handle ===
   "wildan"`, and the token is unchanged. **This is the presence control** the brief's warning
   asks for — it proves fetch WOULD be called in the repairable state, so the two "does nothing"
   tests below are not vacuous absence checks.
2. `"does nothing when both keys are present"` — `setUserSession` first, then asserts
   `calls.length === 0`.
3. `"does nothing when there is no token at all"` — nothing written to storage, asserts
   `calls.length === 0`.
4. `"leaves the user signed out when /users/me 401s"` — writes only the token, mocks a 401,
   asserts `repairSplitSession()` does not throw and `isUserSignedIn()` is `false` afterward
   (relying on `apiFetch`'s existing "clear token on 401" behavior).

Also imported `repairSplitSession` into the test file.

## Step 1+2 combined red phase (recovered after the fact)

Since I had already written the implementation, I reconstructed the red phase by copying the
finished implementation aside and reverting the two implementation files to their pre-Task-7
state while keeping every new/edited test:

```
$ git checkout -- apps/web/src/user/apiClient.ts apps/web/src/App.tsx
$ cd apps/web && bun test src/user/apiClient.test.ts src/App.test.tsx
```

```
src/App.test.tsx:
No routes matched location "blank"
error: expect(received).toBe(expected)
Expected: 1
Received: 0
(fail) App — repairs a split session once, above the router (Task 7) > triggers exactly one /users/me request when the session is split [1009.83ms]
No routes matched location "blank"

src/user/apiClient.test.ts:

# Unhandled error between tests
-------------------------------
SyntaxError: Export named 'repairSplitSession' not found in module '/home/wildandev/repo/diudara/apps/web/src/user/apiClient.ts'.
-------------------------------

 24 pass
 2 fail
 1 error
 52 expect() calls
Ran 26 tests across 2 files. [2.27s]
```

Two distinct, correct failure modes:
- `apiClient.test.ts` fails to even load — `repairSplitSession` doesn't exist yet, so every test
  in that file (including the unrelated pre-existing ones) is reported as an "error", not
  individually. This is the strongest possible red: the code under test is missing entirely.
- `App.test.tsx`'s new split-session test fails with `Expected: 1, Received: 0` — no `/users/me`
  request happens without the `useEffect` wiring, which is exactly what that test checks. The
  other new App test ("no session at all") trivially passed even here, since it asserts an
  absence that's also true pre-implementation — expected, and not a defect, since it's paired
  with the positive-control test above going red.

Then restored:

```
$ cp /tmp/apiClient.ts.new apps/web/src/user/apiClient.ts
$ cp /tmp/App.tsx.new apps/web/src/App.tsx
$ diff /tmp/apiClient.ts.new apps/web/src/user/apiClient.ts   # no output — identical
$ diff /tmp/App.tsx.new apps/web/src/App.tsx                  # no output — identical
$ cd apps/web && bun test src/user/apiClient.test.ts src/App.test.tsx
 86 pass
 0 fail
 171 expect() calls
Ran 86 tests across 2 files. [1333.00ms]
```

## Step 3 — `repairSplitSession`

Added to `apps/web/src/user/apiClient.ts`, right after `getOwnProfile()`:

```ts
export async function repairSplitSession(): Promise<void> {
  if (!isUserSignedIn() || getSessionUser() !== null) return;
  const token = getUserToken();
  if (token === null) return;
  try {
    const me = await getOwnProfile();
    setUserSession(token, { handle: me.handle, displayName: me.displayName, email: me.email });
  } catch {
    // Nothing to do: a 401 has already cleared the token, and any other failure
    // leaves the split state to be retried on the next start.
  }
}
```

Verbatim from the brief, with its docstring. `catch` is deliberately empty: a 401 already clears
the token inside `apiFetch`/`apiRequest`, and any other network failure just leaves the split
state to retry on the next app start.

## Step 4 — wiring at the root

`apps/web/src/App.tsx`:
- Added `import { useEffect } from "react";` and `import { repairSplitSession } from
  "./user/apiClient";`.
- `App`'s body:

  ```tsx
  export default function App() {
    useEffect(() => {
      void repairSplitSession();
    }, []);

    return (
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    );
  }
  ```

  One call site, above `<BrowserRouter>`, so both `/@handle` and `/jelajah` are covered.

`apps/web/src/App.test.tsx`:
- Imported the default export (`import App, { AppRoutes } from "./App";`) and
  `USER_TOKEN_STORAGE_KEY` from `./user/apiClient`, plus `waitFor` from
  `@testing-library/react`.
- New `describe("App — repairs a split session once, above the router (Task 7)", ...)` block,
  the first place in this file that renders `<App />` itself (every other test renders
  `AppRoutes` inside a `MemoryRouter`; `App` brings its own `BrowserRouter`, so it is not
  double-wrapped):

  ```ts
  it("triggers exactly one /users/me request when the session is split", async () => {
    localStorage.setItem(USER_TOKEN_STORAGE_KEY, "jwt-abc");
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ handle: "wildan", displayName: "Wildan", bio: null,
        createdAt: "2026-01-01T00:00:00.000Z", email: "wildan@example.com", whatsappNumber: null });
    }) as unknown as typeof fetch;

    render(<App />);

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toBe("/users/me");
  });

  it("triggers no /users/me request when there is no session at all", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => { calls.push(url); return jsonResponse({}); }) as unknown as typeof fetch;

    render(<App />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(0);
  });
  ```

  This second test is the "no session" side of the required "exactly one ... and none otherwise"
  assertion; the first test is its presence control.

**A wrinkle discovered along the way:** `App` renders a real `<BrowserRouter>`, which reads
`window.location`. happy-dom's default location is `about:blank` (`window.location.pathname` is
literally the string `"blank"`), which matches no route — including the catch-all `*` — so React
Router logs `No routes matched location "blank"` and renders nothing. I tried
`window.history.pushState({}, "", "/")` to fix this (it silently no-ops against `about:blank`'s
null origin) and an absolute-URL `pushState` (throws `SecurityError`, origin mismatch) before
concluding neither is needed: both new tests only assert on `fetch` calls, not on rendered
content, so the harmless console warning doesn't affect correctness. I removed my initial
`await screen.findByRole("heading", ...)` assertion (which *did* depend on a matched route) in
favor of a plain tick-wait, and left the two `No routes matched location "blank"` lines as
expected, harmless noise in the test output — visible in every run below.

## Step 5 — mutation testing

All three mutations applied to the restored (post-Step-2/3/4) implementation, one at a time,
each immediately reverted after confirming red and diffed back to the saved originals.

### Mutation A — invert `getSessionUser() !== null` guard

```diff
-  if (!isUserSignedIn() || getSessionUser() !== null) return;
+  if (!isUserSignedIn() || getSessionUser() === null) return;
```

```
$ bun test src/user/apiClient.test.ts -t "repairSplitSession"
(fail) repairSplitSession > rebuilds the account blob when a token is present and the account is missing [1.72ms]
  Expected: 1 / Received: 0
(fail) repairSplitSession > does nothing when both keys are present [3.23ms]
  Expected: 0 / Received: 1
(fail) repairSplitSession > leaves the user signed out when /users/me 401s [0.46ms]
  Expected: false / Received: true

 1 pass
 3 fail
```

The brief's named target test — "does nothing when both keys are present" — goes red as
required (`Expected: 0, Received: 1`), and two other tests in the block go red too (collateral,
expected: inverting the guard breaks every scenario that depends on it). Reverted; confirmed
`diff` against `/tmp/apiClient.ts.new` is empty.

### Mutation B — remove the `isUserSignedIn()` guard

I first tried the literal, narrow mutation the brief names — deleting only the `!isUserSignedIn()`
clause and leaving the rest of the function untouched:

```diff
-  if (!isUserSignedIn() || getSessionUser() !== null) return;
+  if (getSessionUser() !== null) return;
   const token = getUserToken();
   if (token === null) return;
```

```
$ bun test src/user/apiClient.test.ts -t "repairSplitSession"
 4 pass
 0 fail
```

**This mutation survives.** The reason is a real structural fact I want to flag rather than
paper over: `isUserSignedIn()` is *defined* as `getUserToken() !== null`
(`apiClient.ts:85-87`), and `repairSplitSession` calls `getUserToken()` again immediately after
this guard, with its own `if (token === null) return;`. So the `isUserSignedIn()` clause and the
subsequent `token === null` check are checking the exact same condition twice — removing the
first is a true no-op, not a test gap. No test — however written — could distinguish this
mutation from the unmutated code, because the two lines are behaviorally identical.

To actually exercise the "a signed-out visitor must not hit /users/me" property the brief is
naming, I widened the mutation to remove the whole signed-out guard (both the redundant
`isUserSignedIn()` clause **and** the subsequent `token === null` early return):

```diff
-  if (!isUserSignedIn() || getSessionUser() !== null) return;
+  if (getSessionUser() !== null) return;
   const token = getUserToken();
-  if (token === null) return;
   try {
```

```
$ bun test src/user/apiClient.test.ts -t "repairSplitSession"
error: expect(received).toBe(expected)
Expected: 0
Received: 1
(fail) repairSplitSession > does nothing when there is no token at all [0.73ms]

 3 pass
 1 fail
```

This goes red exactly as the brief specifies for the signed-out test. Reverted both changes;
confirmed `diff` against `/tmp/apiClient.ts.new` is empty and the 4-test block is green again
(`4 pass, 0 fail`).

### Mutation C — remove the `useEffect` from `App`

```diff
 export default function App() {
-  useEffect(() => {
-    void repairSplitSession();
-  }, []);
-
   return (
```

```
$ bun test src/App.test.tsx -t "Task 7"
No routes matched location "blank"
error: expect(received).toBe(expected)
Expected: 1
Received: 0
(fail) App — repairs a split session once, above the router (Task 7) > triggers exactly one /users/me request when the session is split [1053.88ms]

 1 pass
 1 fail
```

Goes red as required. Reverted; `diff` against `/tmp/App.tsx.new` is empty; full `App.test.tsx`
run: `25 pass, 0 fail`.

## Final verification

```
$ bun run typecheck   (repo root)
@diudara/shared typecheck: Exited with code 0
@diudara/worker typecheck: Exited with code 0
@diudara/web typecheck: Exited with code 0
@diudara/api typecheck: Exited with code 0
```

```
$ bun run test   (repo root)
@diudara/shared test:  82 pass / 0 fail  — Ran 82 tests across 4 files. [107.00ms]
@diudara/worker test:  38 pass / 0 fail  — Ran 38 tests across 3 files. [168.00ms]
@diudara/web test:    643 pass / 0 fail  — Ran 643 tests across 44 files. [20.18s]
@diudara/api test:   2036 pass / 0 fail  — Ran 2036 tests across 139 files. [216.43s]
```

Total: 2799 pass, 0 fail (baseline was 2792; +7 new tests: 4 `repairSplitSession` tests, 1 "stored
blob with an id" test, 2 `App`-level tests). No `(fail)` lines anywhere in the captured output
(`grep -c "(fail)"` on the full log returns `0`) — none of the known `apps/api` flakes
(`GrantChannelAccess`, `ProcessRenewals`, `markPaid`, `markPastDue`, `touchProcessing`) fired on
this run.

`git status --short` before commit showed exactly the four intended files. `bun run typecheck`
was also re-run once more after the mutation-testing round-trips, clean.

## Commit

```
e2b3a44 fix(web): repair a split session at the cause
```

4 files changed, 224 insertions(+), 14 deletions(-):
`apps/web/src/App.test.tsx`, `apps/web/src/App.tsx`,
`apps/web/src/user/apiClient.test.ts`, `apps/web/src/user/apiClient.ts`.

---

# Fix round 1

An independent reviewer ran nine mutations against the round-1 work. Seven went red on the right
assertion, it reproduced the disclosed red-phase reconstruction byte-for-byte, and it confirmed the
`isUserSignedIn()` no-op analysis and the decision to widen that mutation were both correct. The
`repairSplitSession` unit tests were called "unusually solid." The defect was not in that code — it
was in what none of those tests looked at: the screen.

## IMPORTANT 1 — the repair fixed `localStorage` but never repaired the SCREEN

**Root cause.** `repairSplitSession` → `setUserSession` → `notify()`. The three `getSessionUser()`
consumers (`FollowButton.tsx:99`, `ProfilePage.tsx:67`, `BerandaPage.tsx:61`) are plain,
unsubscribed, render-time reads — `notify()` only wakes `useSyncExternalStore` subscribers, and the
only ones in this app snapshot `isUserSignedIn()`/`getUserToken()` (`AppShell`, the composer's "Kirim"
button), values that do **not** change across the repair: the token was already present in the split
state. So the repaired storage sat there, correct, while every already-mounted component kept
whatever `getSessionUser()` answered on its last render — which for a component mounted before the
repair landed is `null`. Whether the visible symptom went away was therefore a pure race against
`ProfilePage`'s own `/users/by-handle/...` fetch, and React's child-before-parent effect ordering
loses that race by default (children's effects run before their parent's).

### Step 1 — the failing test, against the pre-fix implementation

Added to `apps/web/src/App.test.tsx`, inside the existing `describe("App — repairs a split session
once, above the router (Task 7)", ...)` block: a `setBrowserPath(path)` helper (using
`(globalThis as any).happyDOM.setURL(...)`, happy-dom's own escape hatch for setting `window.location`
without navigating) so the test could render the **real** `<App />` — not a parallel harness
component that could silently drift from it — pointed at `/@wildan`. `window.history.pushState` does
not work for this: a relative URL silently no-ops against happy-dom's default `about:blank` location,
and an absolute one throws `SecurityError` (origin `null` vs `http://localhost`) — both measured
before landing on `happyDOM.setURL`. An `afterEach` in the same describe block resets the path back to
`"/"`, since happy-dom's window is one process-wide instance shared by the whole `bun test`
invocation, not just this file.

The new test:

```ts
it("removes the stale Ikuti button once the repair lands, even when /users/me resolves AFTER the profile fetch", async () => {
  localStorage.setItem(USER_TOKEN_STORAGE_KEY, "jwt-abc");
  setBrowserPath("/@wildan");

  let resolveMe: (() => void) | null = null;
  const meGate = new Promise<void>((resolve) => { resolveMe = resolve; });

  global.fetch = mock(async (url: string) => {
    if (url.startsWith("/users/by-handle/")) {
      return jsonResponse({ handle: "wildan", displayName: "Wildan", bio: null,
        createdAt: "2026-01-01T00:00:00.000Z", followerCount: 0, followingCount: 0, viewerFollows: false });
    }
    if (url.startsWith("/users/wildan/posts")) {
      return jsonResponse({ posts: [], nextCursor: null });
    }
    if (url === "/users/me") {
      await meGate; // deliberately resolves AFTER the profile fetch — the losing half of the race
      return jsonResponse({ handle: "wildan", displayName: "Wildan", bio: null,
        createdAt: "2026-01-01T00:00:00.000Z", email: "wildan@example.com", whatsappNumber: null });
    }
    throw new Error(`unexpected fetch in this test: ${url}`);
  }) as unknown as typeof fetch;

  render(<App />);

  // Guard: the stale render happens first — this IS the Phase-2 bug, reproduced.
  expect(await screen.findByRole("button", { name: "Ikuti" })).toBeTruthy();

  resolveMe!();

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Ikuti" }) === null).toBe(true);
  });
});
```

Deliberately deterministic, not timing-based: `/users/me` is gated on a promise the test controls
directly, and the guard assertion (`findByRole("button", { name: "Ikuti" })` succeeding) is checked
*before* the real assertion, so if the guard itself ever fails, the test is understood to not be
exercising the race it claims to.

**Red, against the pre-fix `App.tsx`:**

```
(fail) App — repairs a split session once, above the router (Task 7) > removes the stale Ikuti button once the repair lands, even when /users/me resolves AFTER the profile fetch [1140.43ms]
 0 pass
 25 filtered out
 1 fail
 22 expect() calls
```

The `waitFor` timed out with the "Ikuti" button still in the DOM — the stale render never repaints,
confirming the reviewer's diagnosis exactly: storage is repaired, the screen is not.

### Step 2 — the fix

`apps/web/src/App.tsx`:

```tsx
export default function App() {
  const [, setRepaired] = useState(0);
  useEffect(() => {
    void repairSplitSession().then(() => setRepaired((n) => n + 1));
  }, []);

  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
```

One call site, same as before — `setRepaired` bumps state once the repair's promise settles (success
or already-a-no-op; the `.then` only runs after `repairSplitSession`'s own `try`/`catch` has already
resolved it either way), forcing exactly one extra render pass of the whole tree with the corrected
session already in storage. Still fixed at the cause: no consumer screen was touched, and no new
subscription was added to `FollowButton`/`ProfilePage`/`BerandaPage`.

Re-ran the new test: green. Also discovered and fixed an `act()` warning this introduced in the
adjacent "triggers no /users/me request when there is no session at all" test — `repairSplitSession`'s
`.then` still fires a state update as a microtask even in the no-token path (function returns
immediately, but the returned promise still resolves and its `.then` still runs), so that test's
`render` + wait is now wrapped in `await act(async () => { ... })` instead of a bare `render` +
`setTimeout`. No other test needed this; the other two in the block either don't hit the no-op path
or already await through `waitFor`, which wraps in `act` itself.

## Also fixed (items 2–4)

**Item 2 — pinned `displayName`/`email` in the rebuild.** Added to the "rebuilds the account blob..."
test in `apiClient.test.ts`:

```ts
expect(session!.displayName).toBe("Wildan");
expect(session!.email).toBe("wildan@example.com");
```

The mocked `/users/me` response already used `displayName: "Wildan"` (differs from `handle: "wildan"`
in case) and `email: "wildan@example.com"` (differs entirely), specifically so a same-value mutation
cannot hide behind a coincidental match.

**Item 3 — direct id-less-blob test.** Added `"also accepts a stored blob with no id key at all"` to
the `session storage` describe block in `apiClient.test.ts`: writes
`{ handle, displayName, email }` (no `id`) straight into `localStorage` by hand — not through
`setUserSession`/`repairSplitSession`, both of which were already exercised elsewhere — and asserts
`getSessionUser()` returns it. This is `repairSplitSession`'s own rebuilt shape, pinned directly.

**Item 4 — StrictMode caveat, docstring only.** Added a paragraph to the "triggers exactly one
/users/me request..." test in `App.test.tsx` noting that "exactly one" holds because the test renders
`<App />` directly rather than through `main.tsx`'s `<StrictMode>` wrapper, which double-invokes
effects in development (harmless here since `repairSplitSession`'s `getSessionUser() !== null` guard
makes the second call a no-op, but worth naming as a property of the test's harness rather than of
`repairSplitSession` itself). No code change.

## RULING — simplify the redundant guard

`apps/web/src/user/apiClient.ts`, `repairSplitSession`:

```diff
-  if (!isUserSignedIn() || getSessionUser() !== null) return;
+  if (getSessionUser() !== null) return;
+  // No separate `isUserSignedIn()` check here on purpose ...
   const token = getUserToken();
   if (token === null) return;
```

Dropped `!isUserSignedIn() ||`; kept `token === null` and added a comment explaining the token read
IS the signed-in check, so a future reader does not re-add the clause the previous round's mutation
testing showed was dead weight.

## Mutation testing (fix round 1)

All four mutations applied to the fixed implementation, one at a time, each reverted immediately
after confirming red and diffed byte-for-byte against a saved-aside copy of the fixed files
(`/tmp/apiClient.fix1.ts`, `/tmp/App.fix1.tsx`) to confirm exact restoration.

**Mutation D — revert the `.then(setRepaired)` wiring** (drop back to `void repairSplitSession();`
with no state bump):

```
 25 pass
 1 fail
(fail) App — repairs a split session once, above the router (Task 7) > removes the stale Ikuti button once the repair lands, even when /users/me resolves AFTER the profile fetch
```

Only the new race test goes red — cleanly isolated, no collateral damage to the other 25
`App.test.tsx` tests. Restored; `diff` against the saved copy empty.

**Mutation E — remove the remaining `token === null` guard** (the ruling's own claim, re-verified
independently rather than taken on faith):

```
$ bun test src/user/apiClient.test.ts -t "repairSplitSession"
(fail) repairSplitSession > does nothing when there is no token at all
 3 pass / 1 fail

$ bun test src/App.test.tsx -t "Task 7"
(fail) App — repairs a split session once, above the router (Task 7) > triggers no /users/me request when there is no session at all
 2 pass / 1 fail
```

Exactly two tests go red, one in each file — confirms the guard is load-bearing and the ruling's
claim is correct. Restored; `diff` against the saved copy empty.

**Mutation F — item 2's target** (`{ handle: me.handle, displayName: me.handle, email: me.handle }`):

```
(fail) repairSplitSession > rebuilds the account blob when a token is present and the account is missing
error: expect(received).toBe(expected)
Expected: "Wildan"
Received: "wildan"
```

Goes red on exactly the assertion added for this. Restored; `diff` against the saved copy empty.

After each restoration, `bun test src/user/apiClient.test.ts src/App.test.tsx` was re-run and
confirmed green (88 pass, 0 fail) before moving to the next mutation.

## Final verification (fix round 1)

```
$ bun run typecheck   (repo root)
@diudara/shared typecheck: Exited with code 0
@diudara/worker typecheck: Exited with code 0
@diudara/web typecheck: Exited with code 0
@diudara/api typecheck: Exited with code 0
```

Run in the FOREGROUND per the coordinator's explicit instruction (the previous round's background
waiter had stalled — two `pgrep -f` waiters were each matching the other's own command line, so
neither could exit), captured to a file, then read from the file:

```
$ bun run test > .../task7-fix1.txt 2>&1; echo "EXIT: $?"
EXIT: 0

@diudara/shared test:  82 pass / 0 fail — Ran 82 tests across 4 files. [87.00ms]
@diudara/worker test:  38 pass / 0 fail — Ran 38 tests across 3 files. [150.00ms]
@diudara/web test:    645 pass / 0 fail — Ran 645 tests across 44 files. [18.00s]
@diudara/api test:   2036 pass / 0 fail — Ran 2036 tests across 139 files. [204.27s]
```

Total: 2801 pass, 0 fail (baseline for this round was 2799; +2 new tests: the DOM race test in
`App.test.tsx` and the id-less-blob test in `apiClient.test.ts`; item 2's and item 4's changes added
assertions/docstring to existing tests rather than new tests). `grep -c "(fail)"` on the full log
returns `0` — no known `apps/api` flakes fired on this run.

`git status --short` before commit showed exactly the same four files as round 1:
`apps/web/src/App.test.tsx`, `apps/web/src/App.tsx`, `apps/web/src/user/apiClient.test.ts`,
`apps/web/src/user/apiClient.ts`. No route was added; `App.test.tsx`'s shell-partition `toEqual([...])`
arrays are untouched.

## Commit (fix round 1)

```
86d5668 fix(web): repair the SCREEN too, not just localStorage (Task 7 fix round 1)
```

5 files changed, 445 insertions(+), 10 deletions(-):
`apps/web/src/App.test.tsx`, `apps/web/src/App.tsx`, `apps/web/src/user/apiClient.test.ts`,
`apps/web/src/user/apiClient.ts`, `docs/superpowers/sdd/2026-08-18-posts-and-feed/task-7-report.md`.
