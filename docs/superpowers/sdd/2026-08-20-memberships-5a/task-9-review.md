# Task 9 review — Pengaturan: payout and tiers

**Reviewed:** `b574236..58649aa` (3 commits: `6431196`, `f242086`, `58649aa`)
**Against:** `docs/superpowers/specs/2026-08-20-memberships-5a-design.md` §5, §6
**Suite as reviewed:** `bun test` in `apps/web` — **779 pass / 0 fail**, 46 files, 20.8 s.
`bun run typecheck` clean. `git status` clean before and after every mutation below.

## Verdicts

1. **Spec compliance: ✅** against §5 and §6 — with the "edit" verb ruled out of 5a (see §5 below).
2. **Task quality: approved**, with three Minor findings. No Critical, no Important.

---

## 1. §5 — Terima pembayaran, and the state that has three values

`MembershipSettings.tsx` renders **four** branches off `GET /users/me/payout` and exactly **one**
offers a button. Read against `apps/api/src/routes/users.ts:347-370`, which composes
`available = connectUserPayout !== undefined` onto the two booleans `GetUserPayoutStatus` returns:

| wire state | copy | button |
|---|---|---|
| `available: false` | "Pembayaran belum tersedia di server ini. Hubungi dukungan DIUDARA…" | no |
| NULL column | "Anda belum menghubungkan akun pembayaran." | **yes, the only one** |
| sentinel | "Akun pembayaran Anda sedang diverifikasi oleh Xendit… Anda tidak perlu menghubungkan ulang…" | no |
| real account id | "Akun pembayaran Anda sudah terhubung. Anda siap menerima pembayaran keanggotaan." | no |

**A creator waiting on KYC sees *waiting*.** Verified in three directions by the tests, and the
mid-provisioning copy does the one thing that matters operationally: it tells the person **not** to
reconnect. Every connect attempt provisions a Xendit managed sub-account, a KYC entity with no delete
endpoint — the measured 30-accounts-29-orphaned incident spec §5 exists to prevent. A screen that
rendered the sentinel as the blank "you have not started" state would be the UI half of that same bug.

The connect *response* is handled the same way: `handleConnect` replaces the whole `PayoutStatus`
rather than assuming success, so a caller that loses the claim to another device (answered
`provisioning: true`, having called the provider not at all) is shown waiting. Pinned by
"shows waiting when the connect call comes back mid-provisioning".

**The tier editor is genuinely unavailable, not merely hidden.** `connected` is
`payoutLoad.status === "ready" && payoutLoad.payout.connected`; the editor component is not
constructed in any other state, so no `GET /users/me/tiers` is issued, no form fields exist, and no
"Terbitkan tingkatan" button exists to press. Each non-connected state gets its own Bahasa sentence in
`data-testid="tier-editor-unavailable"`, all carrying spec §5's own reason ("uang dari keanggotaan ini
belum punya tempat tujuan"), and **only** the NULL one says "hubungkan… terlebih dahulu".

### The sentinel mutation

```
-  const connected = payoutLoad.status === "ready" && payoutLoad.payout.connected;
+  const connected = payoutLoad.status === "ready" &&
+    (payoutLoad.payout.connected || payoutLoad.payout.provisioning);
```

**Result: 20 pass / 1 fail.** The single test that reddens is

> `MembershipSettings — the tier editor is gated on a CONNECTED account > keeps the editor shut while the account is mid-provisioning, and says WHY it is waiting`

A NULL-only gate test would have passed this mutation; this one does not, and it also asserts the
copy says *waiting* and does **not** say "Hubungkan akun pembayaran Anda terlebih dahulu". Reverted;
tree clean.

`58649aa`'s own fix is real and was worth making: before it, `<h3>Tingkatan keanggotaan</h3>` stood
over nothing whenever the payout status was loading or unreadable — and "status could not be read,
reload" is the one gate reason a person can act on themselves. The gate is now the single `else` of
"is this account connected", with a test pinning both the remedy sentence and the absence of the
wire's string.

## 2. §6 — the editor

Create and deactivate are implemented against the routes as they exist; the offer and the withdrawn
tiers are separate, `data-testid`-scoped lists, which is what makes "removes it from the offer"
assertable as a **count** rather than as an element. Deactivating updates the row from **what the
server returned**, not from what the client assumed. Prices render through `formatRupiah` →
`Rp 50.000` (id-ID grouping), asserted as `/Rp 50\.000/` inside the offer list.

Client-side refusal of an empty name and a non-positive price is justified rather than duplicative:
`ManageUserTiers.create` answers a Bahasa 400, but `describeRequestFailure` chooses from the failure's
*shape* and answers every unlabelled 4xx with "Permintaan tidak dapat diproses" — a round trip would
replace a precise sentence with a vague one. The server stays the authority
(`manage-user-tiers.ts:63-67`).

`createOwnTier` omits `billingCycle` when unnamed, and the server defaults to `monthly`
(`DEFAULT_BILLING_CYCLE`), so the form's "Harga per bulan (Rp)" label is accurate rather than
aspirational. `deactivateOwnTier` takes no boolean, matching `patchUserTierSchema`'s
`z.literal(false)` — the server *refuses* `isActive: true` rather than ignoring it, so a parameter
would only mislead.

## 3. The implementer's own finding — fix verified, reach measured

### The fix reddens, all four

Mutation applied to all four handlers at once (`describeRequestFailure(err)` /
`describeUploadFailure(err)` → `(err as Error).message`):

**17 pass / 4 fail** — exactly the four rewritten tests, and no others:

- `shows Bahasa when the payout status cannot be loaded`
- `shows Bahasa when connecting fails`
- `shows Bahasa of its OWN when creating a tier is refused, not the server's sentence`
- `shows Bahasa when deactivating fails`

`src/test/no-raw-server-errors.test.ts` also reddens under that mutation, naming
`MembershipSettings.tsx` — the source guard and the behavioural tests now agree.

### The diagnosis is precise, and slightly narrower than the report claims

I re-ran the same mutation against the **pre-`f242086`** test file (`git show 6431196:…`): **17 pass /
3 fail**. The three that reddened did so through their *positive* assertion — those used a **regex**
matcher (`findByText(/Server sedang bermasalah/)`), and replacing `describeRequestFailure`'s output
removed our sentence entirely. The one that survived is the create test, whose positive assertion
("Gagal menerbitkan tingkatan") stayed true because only the *appended* half changed, and whose
negative assertion used an **exact-string** matcher that cannot see a sentence a screen appends to
its own.

So the blind form is specifically **`queryAllByText("<exact string>").length === 0`** as a negative
assertion. A regex negative (`queryAllByText(/…/)`) does match a substring of an element's whole text
and is not blind. Rewriting all four was still the right call — the `textContent` form asserts both
directions independently of what the positive half happens to cover.

### Reach: what the grep found

Seven sites in five files under `src/user` use the exact-string negative form:

- `FollowButton.test.tsx:233` — `queryAllByText("user not found")`
- `JelajahPage.test.tsx:384` — `queryAllByText("internal server error")`; also `:376` `queryAllByText(SERVER_MESSAGE)`
- `PostFeed.test.tsx:147` — `queryAllByText("internal server error")` (line 148 repeats it as a regex)
- `FollowListPage.test.tsx:359, :371` — `"internal server error"`, `"Failed to fetch"`
- `ProfilePage.test.tsx:246, :260` — `"internal server error"`, `"Failed to fetch"`

**Measured, not reasoned.** I mutated every *appending* error site in `src/user` at once —
`postOwnerActions.tsx:133`, `PostComposer.tsx:254` and `:374`, plus `FollowButton.tsx:134` rewritten
from a constant into `` `${FOLLOW_FAILED_MESSAGE} ${(err as Error).message}` `` — and ran the whole
directory: **417 pass / 13 fail**. Every file with an appending error path was caught by *something*.

The one test that stayed green under a mutation aimed at exactly what it exists to catch:

> `FollowButton — a failed toggle is not silent (item 7) > never surfaces the server's own error text`

Its positive half is only a presence check (`expect(screen.getByRole("alert")).toBeTruthy()`) and its
negative half is the blind exact-string form, so the appended `"user not found"` passed straight
through it. Two *sibling* tests in the same file caught the mutation, because they assert the alert's
exact text — so nothing can actually ship undetected today. The dedicated test is protected by
accident rather than by design.

The other six sites are all backstopped by a positive assertion strong enough to catch appending —
`expect(screen.getByRole("alert").textContent).toBe("<full sentence>")` in `JelajahPage` and
`PostFeed`, `getByText("<full sentence>")` in `FollowListPage` and `ProfilePage`, whose error paths
render `describeRequestFailure(err)` alone with no prefix. Their negative assertions are decorative,
not load-bearing.

**Conclusion on reach:** the weak *form* is widespread (7 sites); the weak *coverage* is one test,
`FollowButton.test.tsx`'s. `no-raw-server-errors.test.ts` remains the real guard and is green — and
it, not any of these behavioural tests, is what caught the mutation in this task's own file. See
Finding 1.

## 4. The other checks

- **Bahasa Indonesia throughout**, and every refusal names a remedy: connect (NULL), wait and do not
  reconnect (sentinel), contact support (no provider), reload (unreadable status), "Harga tingkatan
  harus lebih dari nol", "Nama tingkatan tidak boleh kosong".
- **`src/test/no-raw-server-errors.test.ts` green**; nothing in the new file reads `.message` off a
  caught binding. `src/test/no-hanging-dom-assertions.test.ts` green and its scan covers the new test
  file.
- **No DOM node on either side of any assertion that can fail** in the three touched test files —
  every `expect(` receives a number (`…queryAllBy….length`, `calls.filter(…).length`), a string
  (`node.textContent`, `input.value`, `calls[0].url`, `headers.get(…)`), a boolean, or a plain parsed
  object. `expect(await findByX(...)).toBeTruthy()` was deliberately not written; bare `await
  findByX(...)` is used instead.
- **Tests assert literals**, never the constants they check: `NOT_CONNECTED` / `PROVISIONING` /
  `CONNECTED` / `NO_PROVIDER` are hand-written literal objects, and the copy is asserted as text.
- **`/dashboard/*` untouched** — the diff is six files, all under `apps/web/src/user`.
- **The section is mounted**, pinned by `SettingsPage.test.tsx`'s new test (every other Task 9 test
  renders the component directly and would stay green if nothing rendered it). Heading order
  `h1 → h2 → h3 → h4` is unbroken. Every CSS class used exists in `src/styles.css`.

## 5. Your two rulings

**Ruling 1 — "edit" leaves 5a: agreed, and 5a is not incomplete without it.**

The server exposes no rename and no reprice: `patchUserTierSchema` is `z.object({ isActive:
z.literal(false) })` and `UserTierRepositoryPort` has no reactivate. Shipping an "Edit" button in the
web app would require a server task, not a UI one — and repricing a tier people already hold is out of
scope by §11, so the only edit that could land is a rename. A rename is fully recoverable through
deactivate-and-create, and that path is the *safer* one for a mis-priced tier: existing members keep
resolving through the withdrawn tier at the price they agreed to, which is exactly §11's rule enforced
by construction rather than by care. Your reading that the spec changes rather than the code is right.

One residue worth writing into the spec amendment rather than leaving implicit: a tier withdrawn to
fix a typo stays visible forever under "Tidak lagi ditawarkan", since nothing deletes and nothing
reactivates. That is clutter on the owner's own screen, not a money or member-facing defect, and I
would not hold 5a for it.

**Ruling 2 — the fourth `available` branch: confirmed, and only the NULL state offers a button.**

Verified in the source (`PayoutState`, four branches, one `<button>`) and in the tests: the
`PROVISIONING`, `CONNECTED` and `NO_PROVIDER` cases each assert
`queryAllByRole("button", { name: "Hubungkan akun pembayaran" }).length === 0`, and only
`NOT_CONNECTED` asserts `1`. Folding `available: false` into NULL would offer a button whose 503 lands
in `describeRequestFailure`'s `status >= 500` branch — "Server sedang bermasalah. Coba lagi sebentar
lagi." — telling a person to retry a thing that cannot succeed until an operator configures the box.
Keeping the branch is right.

---

## Findings

### Minor 1 — one dedicated "never the server's string" test cannot detect the violation it names

`apps/web/src/user/FollowButton.test.tsx:233`. `expect(screen.queryAllByText("user not found").length)
.toBe(0)` with a presence-only positive half; measured green under a mutation that appends the
server's string to `FOLLOW_FAILED_MESSAGE`. Two sibling tests in the same file catch that mutation, so
there is no live exposure — but the test written *for* this rule is the one that misses it, and this
is a rule the project has now fixed four times.

Six more sites use the same exact-string negative form and are all backstopped by a strong positive
assertion: `JelajahPage.test.tsx:376,384`, `PostFeed.test.tsx:147`, `FollowListPage.test.tsx:359,371`,
`ProfilePage.test.tsx:246,260`.

**Fix (not Task 9's to make):** convert these to the shape `f242086` introduced —
`expect(alert.textContent).toContain("<our sentence>")` plus
`expect(alert.textContent).not.toContain("<the wire's string>")`. Worth a small follow-up task across
`src/user`; the branch does not need to hold for it.

### Minor 2 — `handleCreate` synthesises a `ready` tier list out of `loading` or `error`

`MembershipSettings.tsx:339-343`. `setLoad((current) => current.status === "ready" ? … : { status:
"ready", tiers: [created] })`. Two consequences, both edge:

- **Create before the list load resolves:** the in-flight `listOwnTiers().then` (guarded only against
  unmount) overwrites the state afterwards, so the newly created tier disappears from the screen even
  though the server holds it.
- **Create after a failed list load:** the "Gagal memuat tingkatan keanggotaan…" alert silently
  vanishes and "Yang Anda tawarkan" shows the one new tier as though it were the whole offer, when the
  owner may have others the client never managed to read.

Both need a race or a failed GET followed by a successful POST, and neither loses money or data. A
tighter form is to leave a non-`ready` load alone (or re-fetch) rather than to fabricate a list.

### Minor 3 — `!available` is tested before `connected`

`MembershipSettings.tsx:186-194`. A creator holding a real account id on a box whose payment provider
was later de-configured is told "Pembayaran belum tersedia di server ini", while `connected` is still
true and the tier editor stays open beside it. Reachable only by a configuration change after the
fact. The payout sentence is arguably the more useful of the two (nobody can buy without a provider —
`POST /users/:handle/subscribe` 503s), so the inconsistency is between the two halves of the screen
rather than a wrong message; worth at most a sentence acknowledging both facts.

### Nit

Judgement call 3 in the report — that no `GET /users/me/tiers` is issued for a user who has not
onboarded — is not pinned by a test of its own. It follows from the editor-gate tests (the component
is never constructed), so this is an observation rather than a gap.

---

## Hygiene

Four mutations applied and reverted (`git checkout --` after each): the sentinel gate; the raw-string
mutation on all four `MembershipSettings` handlers; the pre-`f242086` test file replayed against that
same mutation; and the four-site appending mutation across `postOwnerActions.tsx`, `PostComposer.tsx`
and `FollowButton.tsx`. Full suite re-run afterwards: **779 pass / 0 fail**. `bun run typecheck`
clean. `git status --porcelain` empty.
