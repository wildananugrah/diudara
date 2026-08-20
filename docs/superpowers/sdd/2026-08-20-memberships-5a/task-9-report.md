# Task 9 — Pengaturan: payout and tiers (implementer report)

**Base:** `b574236`
**Commits:** `6431196`, `f242086`, `58649aa`
**Suite:** web **779 pass / 0 fail** across 46 files, against a **750 pass / 45 files** baseline
(+29 tests, +1 file). `bun run typecheck` clean. `git status` clean.

---

## 1. What I built

### `apps/web/src/user/apiClient.ts` — five calls, two types

Read off the route definitions in `apps/api/src/routes/users.ts` and the use cases behind them
(`GetUserPayoutStatus`, `ConnectUserPayout`, `ManageUserTiers`, `UserTierRow`), not guessed:

| function | route | notes |
|---|---|---|
| `getPayoutStatus()` | `GET /users/me/payout` | read-only, safe on every page load |
| `connectPayout()` | `POST /users/me/payout` | idempotent 200; resolves the RESULTING state, which may be `provisioning` |
| `listOwnTiers()` | `GET /users/me/tiers` | the owner's management view — active AND withdrawn |
| `createOwnTier()` | `POST /users/me/tiers` (201) | integer rupiah; omits `billingCycle` unless named |
| `deactivateOwnTier(id)` | `PATCH /users/me/tiers/:tierId` | sends the only body that route accepts, `{ isActive: false }` |

`PayoutStatus` is `{ connected, provisioning, available }` — three booleans, because the column has
three states and the deployment has a fourth question (see §3). `UserTier` mirrors `UserTierRow` with
`createdAt` as a **string** (JSON has no date type) and `billingCycle` as a free **string**, not a
`"monthly"` literal: the column is a varchar precisely so 5b can widen it without a migration, and a
union here would turn a widened server into a client compile error.

`deactivateOwnTier` takes no boolean. The server has no reactivate — `patchUserTierSchema` **refuses**
`isActive: true` rather than ignoring it — so a parameter would only mislead its caller.

### `apps/web/src/user/MembershipSettings.tsx` — new

`MembershipSettings` (payout status + the gate) and a private `TierEditor` (create, list, withdraw),
plus two pure helpers, `billingCycleLabel` and `parsePriceAmount`.

### `apps/web/src/user/SettingsPage.tsx` — one line plus a comment

`<MembershipSettings />` after the profile card. It loads its own payout status rather than being
handed one, so a payout status that cannot be read cannot take the profile form down with it.

---

## 2. The red phase

Written test-first. The first run was a LOAD failure, which is not a red phase:

```
error: Cannot find module './MembershipSettings' from '.../MembershipSettings.test.tsx'
 0 pass, 1 fail, 1 error
```

So I stubbed — `MembershipSettings` returning a bare `<section className="card stack" />`, and five
`apiClient` functions throwing `not implemented` — and re-ran. **28 failing tests, each for its own
reason** (85 pass alongside them):

The 20 component tests failed on their own assertions, e.g.

```
TestingLibraryElementError: Unable to find an element with the text: Anda belum menghubungkan akun pembayaran.
(fail) ... > offers the connect button when no payout account exists at all
TestingLibraryElementError: Unable to find an element with the text: /Akun pembayaran Anda sedang diverifikasi/
(fail) ... > says the account is being VERIFIED while the provisioning claim is held
TestingLibraryElementError: Unable to find an element by: [data-testid="tier-editor-unavailable"]
(fail) ... > refuses to open the editor, in Bahasa, when no payout account exists
TestingLibraryElementError: Unable to find a label with the text of: Nama tingkatan
(fail) ... > opens the editor once the account is genuinely connected
TestingLibraryElementError: Unable to find an element by: [data-testid="tier-offer"]
(fail) ... > deactivating a tier takes it out of the offer and files it under the withdrawn ones
TestingLibraryElementError: Unable to find role="button" and name "Nonaktifkan"
(fail) ... > shows Bahasa when deactivating fails
```

The 7 `apiClient` tests failed on the absent behaviour itself:

```
error: not implemented
      at connectPayout (.../apiClient.ts:948:13)
(fail) apiClient — payout and tiers (Task 9) > connectPayout POSTs to /users/me/payout and resolves the RESULTING state
```

and the one `SettingsPage` test on:

```
TestingLibraryElementError: Unable to find an element with the text: Terima pembayaran
(fail) SettingsPage > mounts the membership section, which loads its own payout status
```

A 21st component test was added later during self-review (§6) and was red for its own reason before
its branch existed.

---

## 3. How the three payout states render

`app_user.xendit_account_id` is NULL, or holds the `provisioning:in-progress` sentinel
`ConnectUserPayout` writes **before** it calls Xendit, or holds a real account id — **and the sentinel
is truthy**. `GET /users/me/payout` reports that as two booleans plus a third, `available`, which
answers a different question: whether this deployment has a payment provider at all.

So the screen has **four** branches and exactly **one** offers a button:

| state | what it says | button? |
|---|---|---|
| `available: false` | "Pembayaran belum tersedia di server ini. Hubungi dukungan DIUDARA jika Anda ingin mulai menerima pembayaran." | no — a press gets a 503 |
| NULL | "Anda belum menghubungkan akun pembayaran." | **yes** |
| sentinel | "Akun pembayaran Anda sedang diverifikasi oleh Xendit. Pemeriksaan identitas ini bisa memakan waktu beberapa hari kerja, dan Anda tidak perlu menghubungkan ulang — kami akan memakai akun yang sudah Anda daftarkan." | no |
| real id | "Akun pembayaran Anda sudah terhubung. Anda siap menerima pembayaran keanggotaan." | no |

**The mid-provisioning sentence does three things deliberately.** It says the wait is Xendit's identity
check, so the person knows the cause is outside this app; it sets an expectation in days rather than
saying "tunggu"; and it explicitly tells them **not to reconnect**, because every connect attempt
provisions a KYC entity that has no delete endpoint, and a screen that showed the blank
"you-have-not-started" state here would send them round exactly that loop. It is also NOT reported as
connected — the server refuses the sentinel everywhere (`ManageUserTiers.create` 409s it, Task 6
refuses purchases against it), so promising a person they can be paid would be a lie the server would
then enforce against them.

The same distinction is made on the connect *response*: a caller that loses the claim to another
device is answered `provisioning: true` having called the provider not at all, so the handler replaces
the whole status instead of assuming success.

**The gate.** The tier editor renders only when `payout.connected` is true. Every other state — all
three non-connected ones, plus loading and a failed status read — gets a sentence in
`data-testid="tier-editor-unavailable"` saying which state is in the way. All the payout ones carry
spec §5's own reason, "uang dari keanggotaan ini belum punya tempat tujuan", and **only** the NULL one
tells the person to connect:

- NULL: "Hubungkan akun pembayaran Anda terlebih dahulu sebelum membuat tingkatan keanggotaan — uang dari keanggotaan ini belum punya tempat tujuan."
- sentinel: "…karena akun pembayaran Anda masih menunggu verifikasi. Sampai verifikasi selesai, uang dari keanggotaan ini belum punya tempat tujuan."
- no provider: "…karena pembayaran belum tersedia di server ini — uang dari keanggotaan ini belum punya tempat tujuan."
- status unreadable: "…status akun pembayaran Anda tidak dapat dibaca. Muat ulang halaman ini."

---

## 4. Keeping DOM nodes out of failing assertions

**No DOM node appears on either side of any assertion in any file I touched.** Audited by grep over
every `expect(` in the three test files: every one receives a **number** (`…queryAllBy….length`,
`calls.filter(…).length`), a **string** (`element.textContent`, `input.value`, `calls[0].url`,
`headers.get(…)`), a **boolean**, or a **plain object parsed from JSON**.

Two specific choices:

- **`expect(await screen.findByX(...)).toBeTruthy()` was removed, not written.** That form cannot
  actually fail — `findBy` throws first — but it puts an element inside `expect()`, and the twelve
  places I had it are now bare `await screen.findByX(...)`. The wait still fails the test with a
  readable, bounded `TestingLibraryElementError`; nothing hands an element to a matcher.
- **Presence is asserted as a count and content as `textContent`.** Where a test needed to prove a
  *specific* element's text (the gate sentence, the alerts), it captures the node into a local and
  asserts on `node.textContent` — a string on both sides.

`src/test/no-hanging-dom-assertions.test.ts` is green and its source scan covers the new file.
`src/test/no-raw-server-errors.test.ts` is green: nothing in `src/user` reads `.message` off a caught
binding.

---

## 5. Mutation testing (after committing)

Nineteen mutations against the committed source. Every one that changes real behaviour reddens, and a
no-op control stays green:

| # | mutation | result |
|---|---|---|
| M1 | gate treats the sentinel as connected (`connected \|\| provisioning`) | **red** — the provisioning gate test |
| M2 | display folds the sentinel into "connected" | **red** ×3 |
| M4 | form not emptied after a create | **red** |
| M5 | `PATCH` sends `isActive: true` | **red** ×2 (component + apiClient) |
| M9/M10 | local validation does not `return` before the request | **red** ×1 each |
| M11 | zero accepted as a price (`> 0` → `>= 0`) | **red** |
| M12 | editor opens regardless of payout | **red** ×2 (+6 collateral) |
| M13 | section not mounted in Pengaturan | **red** |
| M14 | `connectPayout` uses GET | **red** ×4 |
| M15 | deactivate's result never applied to the list | **red** |
| M17 | raw integer instead of `formatRupiah` | **red** |
| M18 | offer list includes withdrawn tiers | **red** ×2 |
| M19 | withdrawn section never rendered | **red** ×2 |
| control | `tiers` → `tiers.filter(() => true)` | green, as it must be |

**One mutation SURVIVED and produced commit `f242086`.** M3 — replacing `describeRequestFailure(err)`
with the server's own string in the tier-create handler — left all 20 tests green. The cause:
`queryAllByText("<the server's sentence>")` with a **string** matcher is an *exact* match on an
element's text, and the shape this rule keeps being broken in is a screen **appending** the wire's
text to its own, so the element reads `"Gagal menerbitkan tingkatan. <server sentence>"` and matches
nothing. All four "never the server's string" tests now read the alert's `textContent` and assert both
directions. Re-run afterwards, the same mutation on each of the four handlers (create, deactivate,
payout load, connect) reddens exactly its own test.

M16 (`active.map` → `load.tiers.map`) survived but is not a gap: it was masked by the sibling
`active.length === 0` empty-state guard. The honest version of it, M18, reddens two tests.

---

## 6. Self-review, and what it found

Reading my own diff turned up one real defect, fixed in `58649aa`: **`<h3>Tingkatan keanggotaan</h3>`
stood over nothing** whenever the payout status was loading or had failed to load, because the
explanation was rendered only for `status === "ready" && !connected`. The one gate reason a person can
actually act on — the status could not be read, reload — was the one state that said nothing at all.
The gate is now the single `else` of "is this account connected", and
`tierEditorUnavailableReason` takes the whole load state. Its new branch has a test that also pins the
wire's string out of it.

---

## 7. Judgement calls the thin brief left open

1. **No edit, only create and withdraw.** The brief says "create, edit, deactivate" via spec §6, but
   the server exposes no rename and no reprice: `PATCH /users/me/tiers/:tierId` accepts exactly
   `{ isActive: false }`, and price changes for existing members are explicitly out of scope (spec
   §11). An "Edit" button that could only ever fail is worse than no button, so there is none. **If
   editing is wanted, it needs a server task first.**
2. **`available` gets its own branch.** `routes/users.ts` added that flag specifically so
   `connected: false, provisioning: false` stops meaning two different things, and only one of them is
   fixable by pressing a button. Offering "Hubungkan" on a box with no payment provider would earn a
   503 whose `describeRequestFailure` sentence ("Server sedang bermasalah") blames the wrong thing.
3. **Tiers are fetched only once the account is connected.** `TierEditor` mounts only in that state,
   so no `GET /users/me/tiers` is made for a user who has not onboarded — a list that could only be
   empty (the server refuses to create a tier without a connected account).
4. **Withdrawn tiers are shown, in their own section.** Deactivating never deletes the row (spec §4 —
   an existing member's subscription still resolves through it) and there is no reactivate, so an
   owner who withdrew a tier by mistake needs to see that it still exists and is no longer offered.
5. **Two rules are checked client-side, in the server's own words.** An empty name and a
   non-positive price are refused without a request. Not duplication for its own sake:
   `ManageUserTiers.create` answers a 400 whose message is Bahasa, but `describeRequestFailure`
   chooses from the failure's *shape* and answers every unlabelled 4xx with "Permintaan tidak dapat
   diproses" — so a round trip would replace a precise sentence with a vague one. The server remains
   the authority.
6. **Price input is `type="text" inputMode="numeric"`, and non-digits are dropped.** This is money in
   rupiah — a phone keypad is wanted, browser spinners and decimal handling are not. "50.000" and
   "Rp 50.000" both mean 50000, because that is how the price is displayed back to the person.
7. **`formatRupiah` is imported from `src/api.ts`** (already the source for the dashboard's own
   formatting, and already imported into `src/user` by `apiClient.ts` for `ApiError`).
   `billingCycleLabel` is re-declared locally instead of imported from `dashboard/format.ts`: that
   directory is a separate app for a separate account type and Phase 8 deletes it, so a member-facing
   screen importing from it would have to be rewritten then. Only `monthly` is spelled out; unknown
   cycles pass through rather than being hidden.
8. **The section lives inside the profile-loaded branch of `SettingsPage`.** A failed `GET /users/me`
   already replaces that whole page, and splitting the membership section out of that would leave a
   half-rendered Pengaturan. The dependency does not run the other way: a failed payout read leaves
   the profile form untouched.
9. **The heading is "Keanggotaan" with "Terima pembayaran" beneath it** — spec §5 names the payout
   section "Terima pembayaran", and §6 puts the tier editor in the same place, so one `<h2>` carries
   both `<h3>`s. `h1 → h2 → h3 → h4` is unbroken on the page.
10. **`data-testid` on the two lists and the gate sentence.** Deliberate: `within(offer)` scoping is
    what makes "removes it from the offer" assertable as a **count**, which is the DOM-safe form.
