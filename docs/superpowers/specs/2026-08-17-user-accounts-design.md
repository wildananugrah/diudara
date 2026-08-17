# User Accounts, Profiles and Handles — Design Spec

Date: 2026-08-17
Status: Approved for planning
Supersedes nothing. First phase of a deliberate product pivot.

## 1. Purpose, and the pivot this begins

DIUDARA today is a **gateway**: a creator sells access, a member pays, and the member is handed
off to a Telegram group. Members have no accounts — identity is a WhatsApp number, and every
member-facing page is reachable only by holding a URL somebody sent them.

The product is becoming something else: **a place a community actually lives.** One kind of
account. Users follow each other. Users post images and video and go live. Any user can offer
memberships, and can mark content as members-only.

That is a multi-phase rebuild. This spec covers **Phase 1 only**: accounts, profiles and handles.

The agreed sequence, for context:

1. **One kind of account** — this spec
2. Profiles and following
3. Posts and a feed
4. Images
5. Memberships, re-pointed from communities to users
6. Exclusive content
7. Live streaming, re-pointed
8. Retire Telegram

Video is deliberately absent — transcoding is its own project, and it slots in after images once
there is evidence of what people post.

## 2. Nothing migrates, and the old system keeps running

The production database holds only test data; no real payment has ever been taken. So:

- **No data migration anywhere.** Existing creators and members are not converted.
- **The creator dashboard keeps working**, with its own login, untouched.
- **Member status-page links keep working**, untouched.
- The two systems do not know about each other. The old one retires in Phase 8.

**Replacing `creator` and `member` with `user` outright was considered and rejected.** The empty
database removes the data migration, but the cost was never in the data — `creator_id` and
`member_id` are referenced across communities, tiers, subscriptions, checkout, streaming and join
requests. Repointing all of it at once would break most of the suite in a single change. That is
a rewrite, not a phase.

## 3. The user

A new table, independent of `creator` and `member`:

| column | notes |
|---|---|
| `id` | uuid pk |
| `handle` | unique, 3-30 chars, `[a-z0-9_]`, lowercase |
| `email` | unique, case-insensitive |
| `whatsapp_number` | nullable; the second reset channel (§5) |
| `password_hash` | argon2id |
| `display_name` | what people see; not unique |
| `bio` | nullable, max 300 chars |
| `created_at` | |

**No avatar.** Images need the pipeline from Phase 4, and pulling it forward would drag a whole
subsystem into an auth phase.

### 3.1 Handles live at `/@wildan`, never `/wildan`

The `@` prefix is load-bearing rather than cosmetic. Without it every handle competes with the
app's own routes — a user registering `watch`, `dashboard`, `c` or `login` would shadow a real
page, and the defence would be a reserved-word list that must be updated every time a route is
added and will eventually not be.

The prefix makes the collision structurally impossible, so there is no list to maintain and no
way to forget it.

### 3.2 Handles are set at signup and cannot be changed

Changing a handle breaks every link to that profile, and once posts and follows reference users
it also raises the question of who may claim the freed handle. That is worth solving deliberately
later, not by accident now.

**Case:** handles are stored lowercase and compared lowercase. `@Wildan` and `@wildan` are the
same person, and only one can exist.

## 4. Authentication reuses what is already here

- **argon2id** via `Bun.password`, as `AuthenticateCreator` already does — including its dummy-hash
  comparison, so a missing account costs the same time as a wrong password and the endpoint cannot
  be used to enumerate users by timing.
- **The existing JWT issuer**, with a **different audience claim** from the creator token. A
  creator session must never be presentable as a user session, or the reverse. That claim is the
  only thing separating them, since both are signed with `JWT_SECRET`.

Screens: sign up, log in, edit my profile, view any profile at `/@handle`.

## 5. Password reset, on two channels

Reset is in scope for this phase, and it needs a channel. Nothing in this codebase sends email
today; Fonnte sends WhatsApp and has never sent a real message in production.

**Both channels ship.** A user resets by whichever they have.

**Email is required at signup; the WhatsApp number is optional.** Email is the login credential,
so it always exists. The number is offered at signup as "so you can reset your password even if
you lose access to your email, and so we can tell you when someone you follow goes live" — it
earns its place twice, which is why it is worth asking for at all rather than being a bare extra
field on a signup form.

The consequence to design for: **a user who supplies no number has exactly one reset channel**,
and if the email adapter is unconfigured that user has none. The reset screen must offer only the
channels that account actually has, and say plainly when it has none — rather than accepting a
request that nothing can deliver.

**A new `EmailProviderPort` and adapter**, following exactly the pattern the messaging and payment
providers already use: absent configuration disables the channel and does not block boot, and
partial configuration throws in every environment. This is the codebase's established rule and
this phase does not invent a new one.

**WhatsApp reset reuses `MessagingProviderPort`**, which already exists and is already wired.

### 5.1 The rules that make it safe

These are not optional details; a reset flow is the most attacked endpoint in most products.

- **Requesting a reset always answers the same**, whether or not the account exists. Anything else
  turns the endpoint into an account-enumeration oracle.
- **The token is random, single-use, and stored hashed**, never in plaintext. A database read must
  not yield a working reset link.
- **30-minute expiry.** Long enough to find the message, short enough that a leaked link is dead.
- **Using a token invalidates every other outstanding token** for that user.
- **A completed reset ends all existing sessions.** The common reason to reset is that somebody
  else has your password; leaving their session alive defeats the whole exercise.
- **The request endpoint is rate-limited per account and per IP.** Without it, reset becomes a way
  to make the product send unlimited WhatsApp messages at the operator's expense.

## 6. Errors

| Condition | Behaviour |
|---|---|
| Handle already taken | 409, naming the handle, in Indonesian |
| Handle malformed | 400 explaining the rule (3-30, lowercase letters, digits, underscore) |
| Email already registered | **Signup answers as though it succeeded** and sends a "someone tried to sign up with your address" message instead. Telling the browser the address exists is the same enumeration leak as §5.1 |
| Login wrong | One message for wrong email and wrong password alike, never "no such account" |
| Reset requested for unknown account | Same response as a known one (§5.1) |
| Reset token expired, used, or forged | One message: the link is no longer valid, request a new one |
| No reset channel available for this account | **Corrected by the whole-branch review (item 3).** Originally specified as "reset is refused with an explanation" — that cannot be built. §5.1 requires the request endpoint to answer identically whether or not the account exists, and only a real account can lack a channel, so an explicit refusal at request time would itself be an enumeration oracle: a made-up email can never reach this case at all, so any response that looks different immediately confirms the email exists. There is also no session to gate a "your account, tell me its channels" answer behind — the person who needs the message is the one who is locked out. As built: the request answers the identical `200 { ok: true }` as every other case, and the API logs a clearly-tagged operator-facing warning (user id and which channels were considered, never the email address) so "nobody could be reached" is distinguishable from "everything is fine" in the logs even though the HTTP response cannot move. The user-facing answer is prevention, not an after-the-fact refusal: email verification (still unbuilt, see §8) plus an editable `whatsappNumber` (§8) are what keep an account from reaching this state at all. |
| Profile of an unknown handle | 404 page, no hint whether the handle is free |

## 7. Testing

- Handle validation: length, character set, case-folding, and that `@Wildan` collides with
  `@wildan`.
- **A concurrency test that two simultaneous signups for the same handle produce one user** — the
  unique index arbitrates, not a prior read. This codebase's established pattern.
- The dummy-hash path: a login for an unknown email takes comparable time to a wrong password.
- **A user token is rejected by creator-only routes, and a creator token by user-only routes.**
  The audience claim is the only separation and nothing else tests it.
- Reset: token single-use; expired token refused; using one invalidates the others; completing a
  reset ends existing sessions; an unknown account produces an identical response to a known one.
- The email adapter selector under absent, partial and complete configuration, matching how the
  existing provider selectors are tested.
- Profile rendering for a user with no bio, and a 404 for an unknown handle.

## 8. Honest limitations

**Nothing to do yet.** After this phase a user can sign up, log in, set a handle and view a
profile. There is no feed, no content and no follow — those are Phases 2 and 3. This phase is
foundation, and it will feel like it.

**Two account systems exist simultaneously**, and will until Phase 8. A person could hold both a
creator account and a user account with the same email, and the product will not notice or care.
This is accepted deliberately: the alternative was repointing every foreign key in the schema at
once.

**Email deliverability is unproven**, as is Fonnte. Both reset channels ship untested against real
recipients, and the first real test is production. Fonnte in particular has never sent a message
outside this codebase's own fakes, across several phases.

**No email verification, and — corrected by the whole-branch review (item 1) — that is no longer a
small cost.** This section originally claimed a wrong address "costs them one reset channel and
nothing else at this stage." As built, that was false: `whatsappNumber` had a write path (signup)
and a read path (`GET /users/me` and both password-reset channel-choosers) but no *update* path —
`updateProfileSchema` accepted only `displayName` and `bio`, and `SettingsPage` showed the number
read-only. Combined with `chooseChannel` picking email whenever the provider is configured,
regardless of whether the user has a number (a design consequence of §5's ordering, not a
deviation), the real consequence was: **a user who mistypes their email at signup has zero
recovery channels the moment `RESEND_API_KEY` is set, even having supplied a valid WhatsApp
number** — and a user who skipped the number at signup could never add one afterwards, making the
second channel this spec promises permanently unobtainable for them. Plainly: a mistyped email
plus no WhatsApp number on file means no recovery path at all, full stop, and the only real fix is
email verification, which remains unbuilt.

Item 1's fix narrows this without closing it: `PATCH /users/me` now accepts `whatsappNumber`
(same tolerant regex `userSignupSchema` and `startCheckoutSchema` already use; an explicit `null`
clears it, an absent value leaves it alone — matching how `bio` already works), and `SettingsPage`
makes it editable rather than read-only. A signed-in user can now add a number they skipped at
signup, or correct one they mistyped. What this does NOT fix: the one scenario where the mistake
is in the *email* itself — a user who mistypes their email has no session under that address to
sign in with and fix anything, since the account they meant to create does not exist under the
address they can actually log in with. That gap is exactly what email verification would close,
and verification is worth building once there is something in an account worth protecting.

**No rate limit on login**, only on reset. Credential-stuffing protection is real work and belongs
with the account-security phase that also brings verification.

**A duplicate-signup race can write a real email address into the Postgres server log.**
`app_user.email` is a new UNIQUE column, and this project already documents (see the payment and
messaging phases) that Postgres logs the *conflicting value* on a unique-constraint violation. Two
simultaneous signups for the same email race the same way the handle-collision concurrency test
(§7) already covers — one wins, the other's `INSERT` fails the `app_user_email_unique` constraint,
and Postgres's own error-logging writes that email address to the server log as part of reporting
the conflict. This is a pre-existing mechanism (the same thing already happens for every other
unique column this codebase has), applied to a new class of data: a real email address rather than
a handle or an internal id. Not a new vulnerability this phase introduces, but worth naming
because it is the first UNIQUE email column in this codebase.
