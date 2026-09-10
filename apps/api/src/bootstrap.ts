import { db, sql } from "./db/client";
import { DrizzleUserRepository } from "./infrastructure/repositories/drizzle-user.repository";
import { DrizzleUserPayoutRepository } from "./infrastructure/repositories/drizzle-user-payout.repository";
import { BunPasswordHasher } from "./infrastructure/auth/bun-password.hasher";
import { HonoJwtUserTokenIssuer } from "./infrastructure/auth/hono-jwt.user-token-issuer";
import { RegisterUser } from "./application/use-cases/register-user";
import { AuthenticateUser } from "./application/use-cases/authenticate-user";
import { GetUserProfile } from "./application/use-cases/get-user-profile";
import { IsMemberOf } from "./application/use-cases/is-member-of";
import { ListSubscribers } from "./application/use-cases/list-subscribers";
import { MembershipRequests } from "./application/use-cases/membership-requests";
import { RevokeMembership } from "./application/use-cases/revoke-membership";
import { LeaveMembership } from "./application/use-cases/leave-membership";
import { UpdateUserProfile } from "./application/use-cases/update-user-profile";
import { FollowUser, ListFollows } from "./application/use-cases/follow-user";
import { ExploreUsers } from "./application/use-cases/explore-users";
import { DrizzleFollowRepository } from "./infrastructure/repositories/drizzle-follow.repository";
import { DrizzleCommunityRepository } from "./infrastructure/repositories/drizzle-community.repository";
import type { CommunityRepositoryPort } from "./application/ports/community-repository.port";
import { CreateCommunity } from "./application/use-cases/create-community";
import { GetCommunity } from "./application/use-cases/get-community";
import { JoinCommunity } from "./application/use-cases/join-community";
import { BrowseCommunities } from "./application/use-cases/browse-communities";
import { ListCommunityMembers } from "./application/use-cases/list-community-members";
import { DrizzlePostRepository } from "./infrastructure/repositories/drizzle-post.repository";
import { CreatePost, DeletePost, EditPost } from "./application/use-cases/write-post";
import { DrizzleMediaRepository } from "./infrastructure/repositories/drizzle-media.repository";
import { UploadMedia } from "./application/use-cases/upload-media";
import { MediaEntitlement } from "./application/use-cases/media-entitlement";
import { ListFeed, ListUserPosts } from "./application/use-cases/read-posts";
import { RequestPasswordReset } from "./application/use-cases/request-password-reset";
import { CompletePasswordReset } from "./application/use-cases/complete-password-reset";
import { DrizzlePasswordResetRepository } from "./infrastructure/repositories/drizzle-password-reset.repository";
import { DrizzlePasswordResetUnitOfWork } from "./infrastructure/repositories/drizzle-password-reset-unit-of-work";
import { DrizzleSignupNoticeRepository } from "./infrastructure/repositories/drizzle-signup-notice.repository";
import { ConnectUserPayout } from "./application/use-cases/connect-user-payout";
import { GetUserPayoutStatus } from "./application/use-cases/get-user-payout-status";
import { DrizzleUserTierRepository } from "./infrastructure/repositories/drizzle-user-tier.repository";
import { ManageUserTiers } from "./application/use-cases/manage-user-tiers";
import { DrizzleUserSubscriptionRepository } from "./infrastructure/repositories/drizzle-user-subscription.repository";
import { StartUserSubscription } from "./application/use-cases/start-user-subscription";
import { DrizzlePostWriteUnitOfWork } from "./infrastructure/repositories/drizzle-post-write-unit-of-work";
import { HandlePaymentWebhook } from "./application/use-cases/handle-payment-webhook";
import { FakePaymentAdapter } from "./infrastructure/payments/fake-payment.adapter";
import { XenditPaymentAdapter } from "./infrastructure/payments/xendit-payment.adapter";
import { FakeEmailAdapter } from "./infrastructure/email/fake-email.adapter";
import { ResendEmailAdapter } from "./infrastructure/email/resend-email.adapter";
import { DrizzlePaymentActivationUnitOfWork } from "./infrastructure/repositories/drizzle-payment-activation.unit-of-work";
import { DrizzleUserPurchaseUnitOfWork } from "./infrastructure/repositories/drizzle-user-purchase.unit-of-work";
import { SystemClock } from "./infrastructure/clock/system.clock";
import { FakeMessagingAdapter } from "./infrastructure/messaging/fake-messaging.adapter";
import { FonnteWhatsAppAdapter } from "./infrastructure/messaging/fonnte-whatsapp.adapter";
import { MediaMtxAdapter } from "./infrastructure/streaming/mediamtx.adapter";
import { FakeStreamingAdapter } from "./infrastructure/streaming/fake-streaming.adapter";
import {
  StartUserStream,
  ListLiveStreams,
  EndOwnUserStream,
  MintUserWatchToken,
} from "./application/use-cases/start-user-stream";
import { DrizzleUserStreamRepository } from "./infrastructure/repositories/drizzle-user-stream.repository";
import { AuthoriseStream } from "./application/use-cases/authorise-stream";
import { EndUserStream } from "./application/use-cases/end-user-stream";
import { FakeMediaStorageAdapter } from "./infrastructure/storage/fake-media-storage.adapter";
import { S3MediaStorageAdapter } from "./infrastructure/storage/s3-media-storage.adapter";
import type { MessagingProviderPort } from "./application/ports/messaging-provider.port";
import type { MediaStoragePort } from "./application/ports/media-storage.port";
import type { MediaRepositoryPort } from "./application/ports/media-repository.port";
import type { UserRepositoryPort } from "./application/ports/user-repository.port";
import type { UserPayoutRepositoryPort } from "./application/ports/user-payout-repository.port";
import type { UserTierRepositoryPort } from "./application/ports/user-tier-repository.port";
import type { UserTokenIssuerPort } from "./application/ports/user-token-issuer.port";
import type { PaymentProviderPort } from "./application/ports/payment-provider.port";
import type { EmailProviderPort } from "./application/ports/email-provider.port";
import type { StreamingProviderPort } from "./application/ports/streaming-provider.port";

/** Values that may be interpolated into a `DatabasePing` tagged template. */
type PingValue = string | number | boolean | Date | null;

/**
 * The narrowest slice of the SQL client the app is allowed to depend on: a
 * tagged-template liveness probe. The health route calls the database client
 * directly — a deliberate, owner-ruled exception to the ports rule (see the
 * plan's Global Constraints) — but injecting this instead of postgres.js's full
 * `Sql` denies routes `.unsafe()`, `.file()`, `.begin()` and connection control.
 *
 * The rest parameter is `PingValue`, not `unknown`: under `strictFunctionTypes`
 * parameters are contravariant, and postgres.js's own template overload takes
 * `ParameterOrFragment`, so an `unknown` rest makes `Sql` unassignable to this
 * type. `PingValue` keeps interpolation usable while staying assignable.
 */
export type DatabasePing = (
  strings: TemplateStringsArray,
  ...values: PingValue[]
) => Promise<unknown>;

/**
 * The composition root's contract, declared against PORTS rather than inferred
 * from the concrete adapters. Adapter drift now fails at compile time, and
 * use-case tests can inject plain-object fakes without casts.
 */
export interface Dependencies {
  /**
   * The payment adapter THIS process selected — `null` when
   * `selectPaymentProvider` decided the box has no payment provider at all
   * (see that function's own docstring). Exposed for the same reason
   * `messaging`/`aiProvider` are: a test must be able to prove what a given
   * environment actually wired. `null` here is why `connectUserPayout` below
   * is itself optional — there is nothing to construct it against.
   * `startUserSubscription` is DIFFERENT since Task 4 of "free memberships":
   * it is constructed unconditionally and takes `payments` straight through
   * (`null` and all), because a FREE tier needs no provider — see that
   * field's own docstring below.
   */
  payments: PaymentProviderPort | null;
  /**
   * Task 4's email provider — `null` EXACTLY when `selectEmailProvider`
   * decided this box has no email provider at all (see that function's own
   * docstring: absent configuration disables email rather than blocking
   * boot, the same divergence `payments` makes from `messaging`). Exposed
   * for the same reason every other selected provider is: a test must be
   * able to prove what a given environment actually wired, and Task 5's
   * `RequestPasswordReset` needs a real `EmailProviderPort` — not a fake one
   * this field happens to be `truthy` for — to send a reset link over.
   */
  email: EmailProviderPort | null;
  /**
   * Phase 9's personal-account identity, and — since retire-telegram
   * Task 7's fix round deleted `creatorRepository` alongside it — the ONLY
   * identity this process has. Exposed here so a test can seed/read
   * `app_user` rows through the port rather than poking Drizzle directly.
   */
  userRepository: UserRepositoryPort;
  /**
   * Phase 5a's payout column on `app_user`, kept off `userRepository` so that
   * `UserRecord` — which is projected straight into profile responses — never
   * carries a provider account id. Exposed here for the same reason
   * `userRepository` is: a test must be able to put the column into its
   * claimed state WITHOUT going through the POST route, which in the real
   * adapter provisions a KYC entity that has no delete endpoint.
   */
  userPayoutRepository: UserPayoutRepositoryPort;
  /**
   * Task 1's `user_tier` table. Exposed for the same reason
   * `userPayoutRepository` is: `manage-user-tiers.test.ts`'s repository-level
   * coverage lives beside `DrizzleUserTierRepository` itself, but the HTTP
   * suite (`routes/users.test.ts`) needs to seed/read tiers directly too — a
   * subscription fixture, for instance, has to reference a real tier id.
   */
  userTierRepository: UserTierRepositoryPort;
  /**
   * Signs and verifies user-session tokens, and since retire-telegram
   * Task 7's fix round they are the only session kind there is. This was a
   * SEPARATE class from the creator `tokenIssuer`, sharing the same
   * `JWT_SECRET` and kept apart by a `typ` claim rather than a second
   * secret; that issuer went with the creator login it served. `typ: "user"`
   * stays and is still checked — see `HonoJwtUserTokenIssuer`'s own
   * docstring, and `user-auth.middleware.test.ts`, which now FORGES the
   * other audience's token rather than minting one.
   */
  userTokenIssuer: UserTokenIssuerPort;
  /** `POST /users/signup`. Returns `{ ok: true }` only — see the use case's own docstring. */
  registerUser: RegisterUser;
  /** `POST /users/login`. */
  authenticateUser: AuthenticateUser;
  /**
   * Task 3's `GET /users/by-handle/:handle` (public) and `GET /users/me`
   * (behind `requireUserAuth`). One class, two methods — see its own
   * docstring for why the public projection and the owner's own, wider one
   * are kept as separate return types rather than one shape with optional
   * fields.
   */
  getUserProfile: GetUserProfile;
  /** Task 3's `PATCH /users/me`, behind `requireUserAuth`. Handle is not editable — see `updateProfileSchema`. */
  updateUserProfile: UpdateUserProfile;
  /**
   * Task 2 (profiles and following)'s `POST`/`DELETE /users/:handle/follow`.
   * ONE use case for both directions — see its own docstring for why the
   * handle lookup, the self-follow refusal and the 404 are identical either
   * way, and for the precondition it exists to enforce: `FollowRepositoryPort
   * .follow()` does not itself guard a self-follow or a nonexistent target.
   */
  followUser: FollowUser;
  /**
   * Task 2's `GET /users/:handle/followers` and `GET /users/:handle/following`.
   * Public, unauthenticated, sharing `followUser`'s handle-lookup-then-404
   * shape.
   */
  listFollows: ListFollows;
  /**
   * Task 3's `GET /users/explore` — Jelajah, the discovery screen a new user
   * with an empty follow graph lands on. Public, unauthenticated, like
   * `getUserProfile`/`listFollows` above. Reads `userRepository.searchPublic`
   * / `.newestPublic` / `.mostFollowedPublic` — see those port methods' own
   * docstrings for the enumeration-safety guarantee the search path in
   * particular exists to hold (never `email`, never `whatsapp_number`).
   */
  exploreUsers: ExploreUsers;
  /**
   * Phase 1 (communities-core). ONE repository, five consumers — the same
   * arrangement `followRepository` has.
   */
  communityRepository: CommunityRepositoryPort;
  /**
   * `POST /communities`. Behind `requireUserAuth`. Enforces the two
   * preconditions no constraint can — an unsluggable name and a reserved slug
   * — before the write; see its own docstring for why a slug already taken is
   * deliberately NOT among them.
   */
  createCommunity: CreateCommunity;
  /**
   * `GET /communities/:slug`. Public, unauthenticated, resolving an optional
   * viewer — that is what lets one response distinguish an anonymous visitor
   * from a signed-in non-member.
   */
  getCommunity: GetCommunity;
  /**
   * `POST`/`DELETE /communities/:slug/join`. ONE use-case for both
   * directions, `FollowUser`'s arrangement, and idempotent either way.
   */
  joinCommunity: JoinCommunity;
  /** `GET /communities` — the browse grid. Public, like `exploreUsers` above. */
  browseCommunities: BrowseCommunities;
  /** `GET /communities/:slug/members` — the roster. Public. */
  listCommunityMembers: ListCommunityMembers;
  /**
   * Task 2 of posts-and-feed's `POST /users/posts`. Behind `requireUserAuth` —
   * see `routes/posts.ts` for why `PATCH`/`DELETE /users/posts/:id` share the
   * same guard while the two `GET` routes on the same router (`/users/feed`,
   * `/users/:handle/posts`) do not.
   */
  createPost: CreatePost;
  /**
   * Task 7 of images: the resolved `MAX_POST_IMAGES`, defaulting to 5 —
   * see `resolveMaxPostImages`'s own docstring for why it is a runtime env
   * var rather than a shared constant. `postRoutes` reads this to build the
   * `.max()` on `mediaIds` for BOTH `POST /users/posts` and
   * `PATCH /users/posts/:id`, and `GET /users/limits` (mounted by
   * `userRoutes`) reports it verbatim so the web — a static nginx build that
   * cannot read this process's env — can learn it too (images design spec
   * §6). Exposed here, rather than only closed over inside `postRoutes`, for
   * the same reason every other resolved value on this interface is: a test
   * must be able to prove what a given environment actually wired.
   */
  maxPostImages: number;
  /** `PATCH /users/posts/:id`. 403s a post that is not the caller's own, 404s a missing or already-deleted one. */
  editPost: EditPost;
  /** `DELETE /users/posts/:id`. Idempotent — deleting an already-deleted post is not an error. */
  deletePost: DeletePost;
  /**
   * `GET /users/feed`. `tab=untuk-anda` is PUBLIC; `tab=mengikuti` requires a
   * session — the route, not this class, enforces the 401 (see
   * `routes/posts.ts`'s own docstring on that route for why: `/beranda` is a
   * publicly reachable page).
   */
  listFeed: ListFeed;
  /** `GET /users/:handle/posts`. 404s an unknown handle, same as `getUserProfile`/`listFollows`. */
  listUserPosts: ListUserPosts;
  /**
   * Task 5's `POST /users/password-reset/request`. Always answers
   * `{ ok: true }` — see the use-case's own docstring for the enumeration-safety
   * reasoning behind that shape being non-negotiable.
   */
  requestPasswordReset: RequestPasswordReset;
  /**
   * Task 5's `POST /users/password-reset/complete`. A missing, expired or
   * already-used token is a 401 via `UnauthorizedError`, one identical message
   * for all three — see the use-case's own docstring.
   */
  completePasswordReset: CompletePasswordReset;
  /**
   * `POST /users/me/payout` (Phase 5a). `undefined` EXACTLY when `payments`
   * is `null`: there is no `PaymentProviderPort` to construct it against on
   * a box with payments disabled, and `routes/users.ts` answers 503 rather
   * than crashing on a provider it was never handed. (The creator-world
   * `CreatePaymentAccount` this docstring used to mirror went with
   * `POST /payment-account` in retire-telegram Task 7's fix round. The
   * ADAPTER method both use cases call, `PaymentProviderPort
   * .createPaymentAccount`, is UNTOUCHED — it is what this one still
   * provisions through.)
   */
  connectUserPayout: ConnectUserPayout | undefined;
  /**
   * `GET /users/me/payout` (Phase 5a). NEVER undefined, unlike
   * `connectUserPayout` above — a box with no payment provider still has to be
   * able to answer "are you connected?" with `false`, or Task 4's publish screen
   * cannot tell "press the button" apart from "this server cannot take payments
   * at all". Read-only and safe on every page load; the POST route is not.
   */
  getUserPayoutStatus: GetUserPayoutStatus;
  /**
   * Task 4 of Phase 5a. `GET|POST /users/me/tiers` and
   * `PATCH /users/me/tiers/:tierId` — the surface where a creator defines
   * what they are selling. NEVER `undefined`, unlike `connectUserPayout`:
   * this needs no `PaymentProviderPort`, only the payout column's current
   * state, which `getUserPayoutStatus` above answers the same way regardless
   * of whether payments are configured on this box.
   */
  manageUserTiers: ManageUserTiers;
  /**
   * Task 6 of Phase 5a. `POST /users/:handle/subscribe` — the moment money
   * moves on a personal profile, for a PAID tier; for a FREE one, the moment a
   * pending membership is created with nothing owed at all.
   *
   * NO LONGER `undefined` when `payments` is `null` (Task 4 of "free
   * memberships" — this docstring used to say exactly that, mirroring
   * `connectUserPayout` and `startCheckout`, and it was true until this
   * task). A FREE tier needs no `PaymentProviderPort`, so gating the whole
   * use case on one made every subscribe request 503 on a payments-disabled
   * box regardless of price. This is now constructed unconditionally, with
   * `payments` (possibly `null`) passed straight through — the use case
   * itself refuses a PAID tier when `payments` is `null`, so the route no
   * longer needs its own `if (!deps.startUserSubscription)` check at all.
   * See `StartUserSubscription`'s own docstring.
   */
  startUserSubscription: StartUserSubscription;
  /**
   * Task 6 of Phase 5b (spec §8). `GET /users/me/subscribers` — a creator's
   * own subscriber list, owner-only and closed to exactly
   * `{ handle, displayName, since }`. Reading who currently subscribes needs
   * no `PaymentProviderPort` either, only `userSubscriptionRepository`, which
   * exists unconditionally regardless of whether this box takes payments —
   * the same reason `startUserSubscription` above is unconditional since
   * Task 4 of "free memberships".
   */
  listSubscribers: ListSubscribers;
  /**
   * Task 5 of "free memberships": `GET /users/me/membership-requests` and
   * the `/approve`/`/reject` pair beside it — an owner's queue of pending
   * free-membership requests, and the only way one is ever decided.
   * Constructed unconditionally, same reasoning as `listSubscribers` and
   * `startUserSubscription` since Task 4 — nothing here touches
   * `PaymentProviderPort`.
   */
  membershipRequests: MembershipRequests;
  revokeMembership: RevokeMembership;
  leaveMembership: LeaveMembership;
  handlePaymentWebhook: HandlePaymentWebhook;
  /**
   * The messaging adapters THIS process selected. Exposed for the same reason
   * `payments` and `WorkerDependencies.messaging` are: a test must be able to prove
   * what a given environment actually wired, and — for revocation specifically —
   * that a `revokeAccess` really reached the provider with the member id the join
   * webhook recorded. Reading it off a fake constructed by the test instead would
   * prove only that the test can call the fake.
   */
  messaging: MessagingProviders;
  /**
   * The static token Xendit sends as `X-CALLBACK-TOKEN`, the ONLY thing
   * authenticating the webhook route. `undefined` when the box is not
   * configured for webhooks — either because `NODE_ENV` is `development`/
   * `test` (see `RELAXED_NODE_ENVS`), OR — the free-communities addition —
   * because `XENDIT_SECRET_KEY`/`XENDIT_SPLIT_RULE_ID` are BOTH absent too,
   * in which case `resolveCallbackToken` no longer throws even in production
   * (see that function's own docstring: no invoice will ever exist for this
   * webhook to authenticate). Either way `verifyCallbackToken` rejects every
   * delivery rather than accepting any. Deliberately NOT narrowed to
   * `string`: that would force a `?? ""` at the call site, and an empty
   * expected token used to match an empty header.
   */
  xenditCallbackToken: string | undefined;
  /**
   * The resolved public origin of `apps/web` — see `resolveAppBaseUrl`. Exposed
   * here rather than kept private inside the use cases that build links from it
   * (`StartUserSubscription`, `RequestPasswordReset`) so a test can prove the
   * environment variable actually reaches the composition root: the confirmation
   * page was unreachable for an entire phase because nothing checked the wiring.
   */
  appBaseUrl: string;
  sql: DatabasePing;
  /**
   * Task 2's live-streaming provider — the SECOND feature in this codebase
   * (after `aiProvider`) that boots DISABLED rather than refusing to start
   * when unconfigured. See `selectStreamingProvider` for the full decision;
   * `undefined` means MEDIAMTX_RTMP_HOST/MEDIAMTX_HLS_BASE_URL/
   * MEDIAMTX_WHIP_BASE_URL/MEDIAMTX_WEBHOOK_SECRET/STREAM_TOKEN_SECRET are
   * not set and (per the design spec §7) the creator's streaming UI stays
   * hidden rather than offering a "go live" button that always fails,
   * exactly the way `aiProvider: undefined` hides the co-builder chat
   * screen.
   */
  streamingProvider: StreamingProviderPort | undefined;
  /**
   * Task 3 of Phase 7's `POST /streams` — a person goes live on their own
   * profile. `undefined` EXACTLY when `streamingProvider` is: `StartUserStream`
   * requires a real `StreamingProviderPort` rather than accepting `| undefined`
   * and checking internally, so there is nothing to construct it against when
   * streaming is disabled — the "is streaming configured" decision is made once,
   * in `bootstrap()`, not inside the use-case. `routes/streams.ts` checks THIS
   * and answers 503.
   */
  startUserStream: StartUserStream | undefined;
  /**
   * Task 3's `GET /streams` — Siaran's listing. NEVER `undefined`, and that
   * is load-bearing rather than incidental: the listing reads `user_stream`
   * rows and derives each row's playback path from its own id
   * (`userStreamPlaybackPath`), so it needs no provider at all. A listing
   * that failed over a WRITER's dependency would take Siaran down for every
   * reader on a box where nobody configured MediaMTX. It does not even take an
   * optional provider, unlike the community `ListLiveSessions` retire-telegram
   * Task 3 deleted, which had to rebuild each row's URLs from a provider it
   * might not have.
   */
  listLiveStreams: ListLiveStreams;
  /**
   * Task 3's `DELETE /streams/:id` — a creator ends their own broadcast.
   * NEVER `undefined`, same reasoning as `listLiveStreams`: ending a row that
   * already exists needs nothing from the provider, and a creator on a box
   * whose streaming was switched off after they went live must still be able
   * to stop.
   */
  endOwnUserStream: EndOwnUserStream;
  /**
   * Task 5's `POST /streams/:id/watch-token` — the credential a gated user
   * stream's player carries (design spec §5), and the ONE place membership is
   * actually checked for watching.
   *
   * `undefined` EXACTLY when `streamTokenSecret` is — in LOCKSTEP with
   * `authoriseStream`, not with `startUserStream`.
   * The distinction is real and is pinned by a test: a relaxed dev box
   * (`development`/`test` with no streaming vars) gets a truthy
   * `FakeStreamingAdapter`, so `startUserStream` is DEFINED while
   * `STREAM_TOKEN_SECRET` is absent — such a box can go live and cannot mint
   * a watch token, and `routes/streams.ts` answers 503 off each dependency
   * separately rather than inferring one from the other. Signing a token
   * needs the secret and nothing else; there is no provider in the picture.
   */
  mintUserWatchToken: MintUserWatchToken | undefined;
  /**
   * Task 4's `POST /webhooks/mediamtx/auth` decision logic — `undefined`
   * EXACTLY when `streamTokenSecret` is. Mirrors `startUserStream`'s
   * undefined-ness rather than `listLiveStreams`'s: unlike listing,
   * authorising a read needs `STREAM_TOKEN_SECRET` to verify a watch
   * token's signature, so there is nothing to construct it against when
   * streaming is disabled.
   *
   * NOT the same condition as `streamingProvider` being `undefined` — a
   * docstring here once claimed it was, and that was wrong: under a
   * `RELAXED_NODE_ENVS` box (`development`/`test`) with NO streaming
   * variables set at all, `selectStreamingProvider` returns a real,
   * truthy `FakeStreamingAdapter` (see that function's case 3), so
   * `streamingProvider` is defined while `MEDIAMTX_WEBHOOK_SECRET` /
   * `STREAM_TOKEN_SECRET` are genuinely absent and `authoriseStream` stays
   * `undefined`. Concretely: a relaxed dev box has "go live" enabled
   * (`startUserStream` is set) while every call to
   * `POST /webhooks/mediamtx/auth` 401s (see `mediamtxWebhookSecret`
   * below) — a real, if confusing-looking, combination, and the correct
   * one: fail-closed on authorisation is the right default even when
   * publishing itself is happily faked. Do not "fix" the route's
   * `!deps.authoriseStream` guard as dead code on the strength of the old
   * (wrong) claim that it can never be reached — this is exactly the case
   * that reaches it.
   */
  authoriseStream: AuthoriseStream | undefined;
  /**
   * The shared secret `POST /webhooks/mediamtx/auth` requires, checked
   * against EITHER `X-Mediamtx-Secret` (a header — what Task 5's
   * `runOnOnline`/`runOnOffline` shell `curl` commands can send) OR a
   * `secret` query parameter (what MediaMTX's own `authHTTPAddress` POST
   * can carry, since it has no way to attach a custom header — see
   * `routes/mediamtx-webhooks.ts`'s docstring). It is the ONLY
   * authentication on that route either way, exactly like
   * `xenditCallbackToken` above. `undefined` in
   * lockstep with `authoriseStream` (see that field — and see that field
   * for why "in lockstep with `authoriseStream`" is NOT the same thing as
   * "in lockstep with `streamingProvider`"), in which case
   * `verifyCallbackToken` rejects every delivery. Deliberately NOT
   * narrowed to `string`, for the same reason `xenditCallbackToken` is
   * not: that would force a `?? ""` at the call site, and an empty
   * expected token used to match an empty header.
   */
  mediamtxWebhookSecret: string | undefined;
  /**
   * `POST /webhooks/mediamtx/lifecycle`'s decision logic — and, since
   * retire-telegram Task 3 deleted `HandleStreamLifecycle` and the community
   * `live/<key>` world beside it, the ONLY one that route has left.
   *
   * `undefined` in lockstep with `mediamtxWebhookSecret` (both are read off the
   * same `MEDIAMTX_WEBHOOK_SECRET`; see that field for what "in lockstep" does
   * and does not imply). This class needs no secret of its own to do its job —
   * it only reads and writes `user_stream`, unscoped by owner — so gating its
   * construction on the secret is a choice made for symmetry with the route it
   * serves (there is no reachable path to `POST /lifecycle` on a box where the
   * secret is unset) rather than a requirement of the class itself.
   *
   * The route (`routes/mediamtx-webhooks.ts`) still parses `$MTX_PATH` with
   * `parseStreamPath` itself before reaching THIS field, and now REFUSES with a
   * 404 when the path names anything other than the user world — see that
   * route's own docstring for why an unserved namespace must not be
   * acknowledged.
   */
  endUserStream: EndUserStream | undefined;
  /**
   * Phase 4's image storage (Task 2). Never `undefined` and never `null` —
   * mirrors `messaging`, not `payments`/`email`/`streamingProvider`: unlike
   * those three, a box with no bucket configured does not degrade a feature,
   * it refuses to start at all (see `selectMediaStorage`'s own docstring for
   * why an API that accepts uploads and silently keeps them in memory is
   * worse than one that never came up). Exposed for the same reason
   * `messaging` is: a test must be able to prove what a given environment
   * actually wired, and Task 4's upload path needs to assert bytes really
   * reached the SAME adapter `bootstrap()` selected, not a fake the test
   * constructed itself.
   */
  mediaStorage: MediaStoragePort;
  /**
   * Task 4's `POST /users/media`. Writes both re-encoded variants to
   * `mediaStorage` and inserts the unclaimed row — see `UploadMedia`'s own
   * docstring for the ordering between those two writes and why it matters.
   */
  uploadMedia: UploadMedia;
  /**
   * Task 5's delivery routes (`GET /users/media/:id` and `/thumb`) need the
   * row — `findById` — to 404 an id that is well-formed but unknown, and
   * later to give Phase 6's entitlement check something to read ownership
   * and tier from before any bytes leave `mediaStorage`. Exposed as its own
   * field rather than only wired into `uploadMedia`, because that use case
   * is write-only; the SAME instance backs both, constructed once in this
   * function.
   */
  mediaRepository: MediaRepositoryPort;
  /**
   * **BARRIER TWO of Phase 6's paywall** (spec §6.2, §6.4) — the decision
   * `GET /users/media/:id` and `/thumb` make before a single byte leaves
   * `mediaStorage`, and the decision that also chooses their `Cache-Control`.
   *
   * A field on the container rather than something the route builds, for the
   * same reason every other use case here is: the route must be handed the
   * SAME subscription repository and the SAME clock the projection's gate
   * reads, so the two barriers cannot disagree about who is a member or about
   * what time it is.
   */
  mediaEntitlement: MediaEntitlement;
}

/**
 * Minimum JWT_SECRET length. HS256 keys shorter than the hash output (32 bytes)
 * weaken the MAC, and a short secret is offline-brute-forceable from a single
 * captured token — which would forge any creator's session, since every
 * creator's session depends on this one key. `openssl rand -base64 32` produces
 * a conforming value.
 */
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * The literal in `.env.example`. Copying the example file and forgetting to
 * change this line is the single most likely way a real deployment ends up with
 * a publicly-known signing key, and it is long enough to pass the length check.
 */
const PLACEHOLDER_JWT_SECRET = "change_me_to_a_long_random_string";

export function assertUsableJwtSecret(secret: string | undefined): string {
  if (!secret) {
    throw new Error(
      "JWT_SECRET is not set. Add it to apps/api/.env — see .env.example. " +
        "Refusing to start rather than signing tokens with a default secret."
    );
  }
  if (secret === PLACEHOLDER_JWT_SECRET) {
    throw new Error(
      "JWT_SECRET is still the .env.example placeholder. Generate a real one: " +
        "openssl rand -base64 32"
    );
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is too short (${secret.length} characters; ` +
        `${MIN_JWT_SECRET_LENGTH} required). Generate one: openssl rand -base64 32`
    );
  }
  return secret;
}

/**
 * The ONLY `NODE_ENV` values allowed to reach a relaxed configuration branch:
 * the fake payment adapter, and an absent `XENDIT_CALLBACK_TOKEN`.
 *
 * An ALLOWLIST, deliberately — the same shape as `NAMESPACES` in
 * `routes/mediamtx-webhooks.ts`, for the same reason: an unanticipated value
 * must fail CLOSED. The denylist this replaced (`if (nodeEnv === "production") throw`)
 * looked equivalent and was not, because nothing in this repository ever sets
 * `NODE_ENV`:
 *
 *   $ bun -e 'console.log(process.env.NODE_ENV)'   ->  undefined
 *
 * There is no `start` script, no Dockerfile, and no API service in
 * infra/docker-compose.yml, so the FIRST real deployment would have run with
 * `NODE_ENV` unset and taken the unsafe branch — booting the fake adapter,
 * writing unrecoverable `fake-acct-*` ids into `creator.xendit_account_id`, and
 * rejecting every webhook delivery. `"staging"`, `"prod"` and `"PRODUCTION"`
 * were unsafe for the same reason. Under this allowlist, all four used to throw
 * for payments — free communities changed that specifically for
 * `selectPaymentProvider`/`resolveCallbackToken` (see their own docstrings:
 * absent Xendit configuration now boots with payments DISABLED rather than
 * refusing to start), which is why this file has TWO shapes of "outside the
 * allowlist" today, not one. Messaging (`selectMessagingProviders`) and
 * streaming's partial-configuration case are unaffected and still throw.
 *
 * `"test"` is in here because `bun test` sets it (the same mechanism
 * `resetDatabase()` relies on) and the whole suite depends on the fake adapter.
 * `"development"` is here so `bun run dev` works — which is why
 * `NODE_ENV=development` is now in `apps/api/.env.example`.
 *
 * Adding a value to this set is a decision to let that environment take fake
 * money. Do not add `"staging"`: a staging box that charges nobody proves
 * nothing about the payment path, and Xendit has a test-mode secret key for it.
 */
export const RELAXED_NODE_ENVS: ReadonlySet<string> = new Set(["development", "test"]);

function isRelaxedNodeEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv !== undefined && RELAXED_NODE_ENVS.has(nodeEnv);
}

/** Renders `NODE_ENV` for an error message, distinguishing unset from a value. */
function describeNodeEnv(nodeEnv: string | undefined): string {
  return nodeEnv === undefined ? "not set" : nodeEnv;
}

/** The names in `RELAXED_NODE_ENVS`, for error messages. */
const RELAXED_NODE_ENVS_LIST = [...RELAXED_NODE_ENVS].sort().join(" or ");

/**
 * Minimum `XENDIT_CALLBACK_TOKEN` length, mirroring `MIN_JWT_SECRET_LENGTH`
 * above on purpose. This token is the ONLY authentication on
 * `POST /webhooks/xendit` — Xendit signs nothing — so it is exactly as
 * load-bearing as the JWT signing key, and it was accepting a value of `"x"`.
 * A short token is brute-forceable against a live endpoint, and forging a
 * callback grants free access to every paid community on the box. Real Xendit
 * dashboard tokens are comfortably longer than this.
 */
const MIN_CALLBACK_TOKEN_LENGTH = 32;

/**
 * Normalises an env var to `undefined` when it carries no value. A variable
 * exported as `XENDIT_SECRET_KEY=` arrives as `""`, which is indistinguishable
 * from a typo'd name in intent but NOT in truthiness once someone writes
 * `env.secretKey !== undefined`. Whitespace-only is treated the same way: a
 * value copied out of a dashboard with a trailing space is not configuration.
 */
function presentOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === "" ? undefined : value;
}

/**
 * Chooses the payment adapter — or chooses to have no payment path at all,
 * rather than ever taking fake money for real.
 *
 * The fake adapter settles nothing while looking, from the outside, exactly
 * like it did. Worse, a connect use case writes its `fake-acct-*` id into the
 * payout column and then 409s forever, so anyone onboarded on a misconfigured
 * production box can never connect a real Xendit sub-account without manual
 * SQL. (Measured on the creator flow, whose `CreatePaymentAccount` went with
 * `POST /payment-account` in retire-telegram Task 7's fix round;
 * `ConnectUserPayout` writes `app_user.xendit_account_id` the same way.) A `console.log` is not a safety mechanism — these two
 * guards are (see the plan's Global Constraints):
 *
 *   1. PARTIAL configuration throws in EVERY environment. A set secret key with
 *      an unset split rule id is never intentional; it is a typo that makes an
 *      operator believe payments are live.
 *   2. ABSENT configuration selects the fake adapter ONLY when `NODE_ENV` is
 *      one of `RELAXED_NODE_ENVS` — an allowlist, so `undefined`, `"staging"`,
 *      `"prod"` and `"PRODUCTION"` never get it. See RELAXED_NODE_ENVS for why
 *      the denylist this replaced never fired.
 *
 * Outside that allowlist, absent configuration used to make this THROW —
 * refusing to boot at all. Free communities (`community.access_mode =
 * "request"`) changed that: a box can now be entirely useful with no payment
 * provider, so refusing to start over it stopped being the safe choice and
 * became the unhelpful one. `null` — see the return type — is what replaced
 * the throw:
 *
 *   - The fake adapter writes unrecoverable `fake-acct-*` ids into the payout
 *     column, so falling back to it here (`?? new
 *     FakePaymentAdapter()`, or any other stand-in that answers real calls)
 *     would ship exactly the disaster the original throw existed to prevent
 *     — a box that LOOKS like it takes payments and only takes fake ones.
 *   - `null` is genuinely absent instead: `bootstrap()` does not construct
 *     `StartUserSubscription` or `ConnectUserPayout` when this returns `null`,
 *     and each of their routes answers 503 off its own `undefined` dependency.
 *     There is nothing left in the process for a caller to reach that would
 *     pretend to take a payment. (There were four. Retire-telegram Task 4
 *     deleted `StartCheckout`, whose `POST /c/:slug/checkout` route was not
 *     even registered in that case — the community checkout and that
 *     asymmetry went together; Task 7's fix round deleted
 *     `CreatePaymentAccount` with `POST /payment-account`.)
 *
 * Mirrors `assertUsableJwtSecret` above in shape and error wording for the
 * two cases that still throw.
 */
export function selectPaymentProvider(env: {
  secretKey: string | undefined;
  splitRuleId: string | undefined;
  nodeEnv: string | undefined;
}): PaymentProviderPort | null {
  const secretKey = presentOrUndefined(env.secretKey);
  const splitRuleId = presentOrUndefined(env.splitRuleId);

  if (secretKey && splitRuleId) {
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] payments provider: XenditPaymentAdapter " +
        "(XENDIT_SECRET_KEY and XENDIT_SPLIT_RULE_ID are set — real money will move)"
    );
    return new XenditPaymentAdapter({ secretKey, splitRuleId });
  }

  if (secretKey || splitRuleId) {
    const missing = secretKey ? "XENDIT_SPLIT_RULE_ID" : "XENDIT_SECRET_KEY";
    const present = secretKey ? "XENDIT_SECRET_KEY" : "XENDIT_SPLIT_RULE_ID";
    throw new Error(
      `Xendit is half-configured: ${present} is set but ${missing} is not. ` +
        "Set both or neither — see apps/api/.env.example. Refusing to start rather " +
        "than falling back to the fake payment adapter while looking configured."
    );
  }

  if (!isRelaxedNodeEnv(env.nodeEnv)) {
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] payments provider: none — payments are DISABLED " +
        "(XENDIT_SECRET_KEY/XENDIT_SPLIT_RULE_ID not set, and NODE_ENV is " +
        `${describeNodeEnv(env.nodeEnv)}, outside ${RELAXED_NODE_ENVS_LIST}). ` +
        "POST /c/:slug/checkout is not registered and 404s; communities on this " +
        'box must use access_mode = "request". Set both Xendit keys to enable ' +
        "real payments, or NODE_ENV=development/test to boot with the fake " +
        "adapter instead."
    );
    return null;
  }

  logProviderChoice(
    env.nodeEnv,
    "[bootstrap] payments provider: FakePaymentAdapter " +
      "(XENDIT_SECRET_KEY/XENDIT_SPLIT_RULE_ID not set — no real money will move; " +
      "set both to switch to the real Xendit adapter)"
  );
  return new FakePaymentAdapter();
}

/**
 * The messaging providers a process needs to reach a person.
 *
 * ONE field now. It used to carry a second — `gating`, a map of providers keyed
 * by `channel.platform`, whose only consumers were the channel-access use cases
 * retire-telegram Task 2 deleted along with the Telegram adapter that was the
 * only thing in it that could actually gate. The distinction it encoded
 * (notifying and gating are different capabilities, and `TelegramBotAdapter.notify`
 * THREW) has no second side left to be confused with.
 *
 * Still a wrapper rather than a bare `MessagingProviderPort`: both composition
 * roots expose this so a test can prove which adapters an environment selected,
 * and the field name is what makes "the WhatsApp one" explicit at every call
 * site.
 */
export interface MessagingProviders {
  /** How the PERSON is reached. WhatsApp, always. */
  notifier: MessagingProviderPort;
}

/**
 * Chooses the messaging adapters, refusing to start rather than pretending to
 * invite anyone.
 *
 * Deliberately the same shape, thresholds and reasoning as
 * `selectPaymentProvider` above:
 *
 *   1. `FONNTE_API_TOKEN` set -> the real adapter, in every environment.
 *   2. ABSENT configuration selects `FakeMessagingAdapter` ONLY when `NODE_ENV`
 *      is in `RELAXED_NODE_ENVS` — so `undefined`, `"staging"`, `"prod"` and
 *      `"production"` all throw. The fake records sends into an array instead of
 *      making them, so a box running it looks exactly like a working one from the
 *      outside while every paying member waits for a message that will never
 *      arrive. That is this phase's worst failure mode (plan, Global
 *      Constraints), and it is worth refusing to boot over.
 *
 * `FONNTE_API_TOKEN` is a bearer credential, so the startup line names the
 * adapter and never the value.
 *
 * Retire-telegram Task 2 removed the `TELEGRAM_BOT_TOKEN` half. There is no
 * half-configured case left to throw over — one token cannot disagree with
 * itself — so case 2 above is gone with it, and the block-boot guard on the
 * ABSENT case, which is the one that actually protects a paying member, is
 * unchanged.
 */
export function selectMessagingProviders(env: {
  fonnteApiToken: string | undefined;
  nodeEnv: string | undefined;
}): MessagingProviders {
  const fonnteApiToken = presentOrUndefined(env.fonnteApiToken);

  if (fonnteApiToken) {
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] messaging provider: FonnteWhatsAppAdapter (notification) — " +
        "FONNTE_API_TOKEN is set, so real messages will be sent"
    );
    return { notifier: new FonnteWhatsAppAdapter({ apiToken: fonnteApiToken }) };
  }

  if (!isRelaxedNodeEnv(env.nodeEnv)) {
    throw new Error(
      "FONNTE_API_TOKEN is not set, and NODE_ENV is " +
        `${describeNodeEnv(env.nodeEnv)}. FakeMessagingAdapter is permitted ONLY when ` +
        `NODE_ENV is exactly ${RELAXED_NODE_ENVS_LIST}: it appends sends to an array, so a ` +
        "box running it looks like it is messaging paying members while nobody receives " +
        "anything. Add the token to apps/api/.env — see .env.example — or set " +
        "NODE_ENV=development."
    );
  }

  logProviderChoice(
    env.nodeEnv,
    "[bootstrap] messaging provider: FakeMessagingAdapter for notification " +
      "(FONNTE_API_TOKEN not set — no message is sent; set it to switch to the real adapter)"
  );
  return { notifier: new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false }) };
}

/**
 * Chooses the email adapter — or chooses to have no email path at all, rather
 * than ever pretending a real send happened.
 *
 * Task 5's password reset is the first consumer, and it is deliberately built
 * to tolerate email being absent: `RequestPasswordReset` falls back to
 * WhatsApp when a user has a number and messaging is configured (design spec,
 * Task 5), and produces no send at all — not an error — when NEITHER channel
 * is available. That is what makes `selectEmailProvider` shaped like
 * `selectPaymentProvider` rather than like `selectMessagingProviders`: unlike
 * an invite nobody can be told about, a missing email provider degrades to a
 * SECOND, ALREADY-BUILT channel rather than to "the feature does not work at
 * all", so refusing to boot over it would be the wrong trade — exactly the
 * reasoning that turned `selectPaymentProvider`'s old throw into today's
 * `null` once free communities gave it a genuinely payment-free path.
 *
 *   1. Both `RESEND_API_KEY` and `EMAIL_FROM` set -> `ResendEmailAdapter`, in
 *      EVERY environment.
 *   2. PARTIAL configuration throws in EVERY environment — same reasoning as
 *      every other half-configured guard in this file: an API key with no
 *      "from" address (or vice versa) is a typo, never intentional, and an
 *      operator who set one believes email is live.
 *   3. ABSENT configuration selects `FakeEmailAdapter` ONLY inside
 *      `RELAXED_NODE_ENVS` (development/test) — the fake records sends into
 *      an array instead of making them.
 *   4. ABSENT configuration OUTSIDE the allowlist returns `null` RATHER THAN
 *      THROWING, and rather than falling back to the fake: `null` is
 *      genuinely absent, so `RequestPasswordReset` (Task 5) can see there is
 *      no email channel and try WhatsApp instead — a fake that silently
 *      "worked" would tell it there was a channel when there was not, and no
 *      reset link would ever leave this process.
 *
 * `RESEND_API_KEY` is a bearer credential, so the startup line names the
 * adapter and never the key — same rule as the Telegram/Fonnte tokens above.
 */
export function selectEmailProvider(env: {
  apiKey: string | undefined;
  from: string | undefined;
  nodeEnv: string | undefined;
}): EmailProviderPort | null {
  const apiKey = presentOrUndefined(env.apiKey);
  const from = presentOrUndefined(env.from);

  if (apiKey && from) {
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] email provider: ResendEmailAdapter " +
        "(RESEND_API_KEY and EMAIL_FROM are set — real email will be sent)"
    );
    return new ResendEmailAdapter({ apiKey, from });
  }

  if (apiKey || from) {
    const missing = apiKey ? "EMAIL_FROM" : "RESEND_API_KEY";
    const present = apiKey ? "RESEND_API_KEY" : "EMAIL_FROM";
    throw new Error(
      `Email is half-configured: ${present} is set but ${missing} is not. Set both or ` +
        "neither — see apps/api/.env.example. Refusing to start rather than falling back to " +
        "the fake email adapter while looking configured."
    );
  }

  if (!isRelaxedNodeEnv(env.nodeEnv)) {
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] email provider: none — email is DISABLED " +
        "(RESEND_API_KEY/EMAIL_FROM not set, and NODE_ENV is " +
        `${describeNodeEnv(env.nodeEnv)}, outside ${RELAXED_NODE_ENVS_LIST}). Password reset ` +
        "(Task 5) falls back to WhatsApp where a user has a number and messaging is " +
        "configured, and sends nothing when neither channel is available. Set both env vars " +
        "to enable real email, or NODE_ENV=development/test to boot with the fake adapter " +
        "instead."
    );
    return null;
  }

  // `echo` ONLY under development, never under test — see `FakeEmailAdapter`'s
  // own docstring for why the fake has to print at all (its `sent` array is
  // unreachable from outside this process, so local development could not
  // complete a password reset), and `logProviderChoice` just above for why
  // `test` is the one environment that must stay silent.
  const echo = env.nodeEnv === "development";
  logProviderChoice(
    env.nodeEnv,
    "[bootstrap] email provider: FakeEmailAdapter " +
      "(RESEND_API_KEY/EMAIL_FROM not set — no real email will be sent; set both to switch " +
      "to the real Resend adapter)" +
      (echo
        ? " — every message is printed to this log instead, reset links included, so the " +
          "password-reset flow can actually be completed locally"
        : "")
  );
  return new FakeEmailAdapter({ echo });
}

/**
 * The most images a single post may carry. Task 6 built `mediaIds` on both
 * create and edit but deliberately left the cap unenforced; this is it.
 *
 * A RUNTIME env var rather than a shared constant (images design spec §6) —
 * the owner's tradeoff, taken knowingly: the web is a static nginx build and
 * cannot read an API-side env var, so `GET /users/limits` exists for it to
 * learn this number instead of importing it.
 */
export const DEFAULT_MAX_POST_IMAGES = 5;

/**
 * Parses `MAX_POST_IMAGES`. Unlike `resolveAiDailyMessageLimit` above, this
 * takes the raw string directly rather than `{ value }` — there is only ever
 * one thing to resolve here, and `postRoutes`/`bootstrap()` both call it with
 * exactly `process.env.MAX_POST_IMAGES`.
 *
 * Same fail-closed shape as `resolveAiDailyMessageLimit` and for the same
 * reason: `Number("abc")` is `NaN`, and a cap silently coerced to `NaN` would
 * make every `mediaIds.length <= NaN` comparison false — "reject every post
 * with an image", not "no cap" — the opposite of what an operator
 * fat-fingering this value would expect. Called UNCONDITIONALLY in
 * `bootstrap()`, not gated behind a feature flag the way
 * `resolveAiDailyMessageLimit` is gated behind `aiProvider`: posting is a
 * core feature on every box, so a malformed value here must fail boot on
 * every box, not just some.
 */
export function resolveMaxPostImages(value: string | undefined): number {
  const raw = presentOrUndefined(value);
  if (raw === undefined) {
    return DEFAULT_MAX_POST_IMAGES;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `MAX_POST_IMAGES must be a whole number of at least 1 (got "${raw}"). Unset it to ` +
        `use the default of ${DEFAULT_MAX_POST_IMAGES}.`
    );
  }
  return parsed;
}

/**
 * Minimum `MEDIAMTX_WEBHOOK_SECRET`/`STREAM_TOKEN_SECRET` length, the same
 * floor as `JWT_SECRET`/`XENDIT_CALLBACK_TOKEN` above and for the same reason:
 * `MEDIAMTX_WEBHOOK_SECRET` is the ONLY authentication on both MediaMTX
 * webhooks (Task 4), and
 * `STREAM_TOKEN_SECRET` signs every watch token
 * (`apps/api/src/domain/user-watch-token.ts`) — a short one is
 * offline-brute-forceable from a single leaked token or webhook payload, and
 * either lets an attacker reach a paid stream they never paid for.
 */
const MIN_STREAMING_SECRET_LENGTH = 32;

/** The five env vars that make up streaming configuration, for error text. */
const STREAMING_ENV_VAR_NAMES = {
  rtmpHost: "MEDIAMTX_RTMP_HOST",
  hlsBaseUrl: "MEDIAMTX_HLS_BASE_URL",
  whipBaseUrl: "MEDIAMTX_WHIP_BASE_URL",
  webhookSecret: "MEDIAMTX_WEBHOOK_SECRET",
  streamTokenSecret: "STREAM_TOKEN_SECRET",
} as const;

/**
 * Length floor for a present streaming secret, checked only once all five
 * streaming variables are known to be set — see `selectStreamingProvider`.
 * Mirrors `assertUsableJwtSecret` above in shape.
 */
export function assertUsableStreamingSecret(name: string, secret: string): void {
  if (secret.length < MIN_STREAMING_SECRET_LENGTH) {
    throw new Error(
      `${name} is too short (${secret.length} characters; ${MIN_STREAMING_SECRET_LENGTH} ` +
        `required). It is load-bearing for access to paid streams. Generate one: ` +
        "openssl rand -hex 32"
    );
  }
}

/**
 * Chooses the live-streaming provider adapter — the SECOND selector in this
 * file (after `selectAiProvider`) that boots DISABLED rather than refusing
 * to start when unconfigured, and deliberately so (design spec §7, plan
 * Global Constraints): a community with no live streaming still charges
 * members and gates its Telegram/WhatsApp channels exactly as before, so
 * refusing to boot over a missing MediaMTX host would let an OPTIONAL
 * feature take down a REQUIRED one.
 *
 * Same shape as `selectAiProvider`, generalised from two variables to five
 * because a live session needs all of them or none. `MEDIAMTX_WHIP_BASE_URL`
 * (Task 2) joined the other four: the public https:// origin nginx proxies a
 * creator's BROWSER publish (WHIP) to, alongside RTMP for OBS.
 *
 *   1. All five set -> `MediaMtxAdapter`, in EVERY environment, once the two
 *      secrets clear `MIN_STREAMING_SECRET_LENGTH` (checked here, at BOOT,
 *      rather than deferred to whatever later reads them — a short secret
 *      must fail loudly now, not as a webhook that silently never
 *      authenticates or a token nobody can forge protection against).
 *   2. PARTIAL configuration (1-4 of the five set) throws in EVERY
 *      environment — the same rule `selectPaymentProvider` and
 *      `selectMessagingProviders` apply to their own pairs, extended to
 *      five: a host with no webhook secret is a webhook nothing can
 *      authenticate, and a webhook secret with no host is a signing key
 *      naming a stream nobody can reach.
 *   3. NONE set, INSIDE `RELAXED_NODE_ENVS` -> `FakeStreamingAdapter`, the
 *      SAME allowlist reused from `isRelaxedNodeEnv` (see `selectAiProvider`
 *      above for why this is not a second gate).
 *   4. NONE set, OUTSIDE `RELAXED_NODE_ENVS` -> `undefined`. THE FEATURE IS
 *      DISABLED, NOT THE BOOT — same divergence `selectAiProvider` makes
 *      from `selectMessagingProviders` (which still throws here), and for
 *      the same reason: nothing is on the line if streaming is simply
 *      unavailable. `selectPaymentProvider` joined this side of the
 *      divergence too, once free communities gave payments a genuinely
 *      disabled state (`null`, not a throw) — see its own docstring.
 *
 * Case 4 is the one this project has paid for twice already (Phase 3,
 * `RELAXED_NODE_ENVS`'s own docstring): a guard that is correct in isolation
 * but whose trigger point — an unrecognised or unset `NODE_ENV` — is never
 * actually exercised by a test is no guard at all. `bootstrap.test.ts` pins
 * this for `production`, a plausible misspelling (`"Development"`, which
 * `RELAXED_NODE_ENVS` — a `Set`, not a case-insensitive check — correctly
 * treats as unrecognised), and unset, crossed with streaming configuration
 * that is genuinely absent and with configuration that is present but
 * blank/whitespace-only (which `presentOrUndefined` normalises to the same
 * "absent" state) — none of those combinations may throw.
 */
export function selectStreamingProvider(env: {
  rtmpHost: string | undefined;
  hlsBaseUrl: string | undefined;
  whipBaseUrl: string | undefined;
  webhookSecret: string | undefined;
  streamTokenSecret: string | undefined;
  nodeEnv: string | undefined;
}): StreamingProviderPort | undefined {
  const values = {
    rtmpHost: presentOrUndefined(env.rtmpHost),
    hlsBaseUrl: presentOrUndefined(env.hlsBaseUrl),
    whipBaseUrl: presentOrUndefined(env.whipBaseUrl),
    webhookSecret: presentOrUndefined(env.webhookSecret),
    streamTokenSecret: presentOrUndefined(env.streamTokenSecret),
  };
  const entries = Object.entries(values) as [keyof typeof values, string | undefined][];
  const setCount = entries.filter(([, value]) => value !== undefined).length;

  if (setCount === entries.length) {
    assertUsableStreamingSecret("MEDIAMTX_WEBHOOK_SECRET", values.webhookSecret as string);
    assertUsableStreamingSecret("STREAM_TOKEN_SECRET", values.streamTokenSecret as string);
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] streaming provider: MediaMtxAdapter " +
        "(MEDIAMTX_RTMP_HOST/MEDIAMTX_HLS_BASE_URL/MEDIAMTX_WHIP_BASE_URL/MEDIAMTX_WEBHOOK_SECRET/" +
        "STREAM_TOKEN_SECRET are all set — live streaming is available)"
    );
    return new MediaMtxAdapter({
      rtmpHost: values.rtmpHost as string,
      hlsBaseUrl: values.hlsBaseUrl as string,
      whipBaseUrl: values.whipBaseUrl as string,
    });
  }

  if (setCount > 0) {
    const present = entries
      .filter(([, value]) => value !== undefined)
      .map(([key]) => STREAMING_ENV_VAR_NAMES[key]);
    const missing = entries
      .filter(([, value]) => value === undefined)
      .map(([key]) => STREAMING_ENV_VAR_NAMES[key]);
    throw new Error(
      `Streaming is half-configured: ${present.join(", ")} set but ${missing.join(", ")} not. ` +
        "Set MEDIAMTX_RTMP_HOST, MEDIAMTX_HLS_BASE_URL, MEDIAMTX_WHIP_BASE_URL, " +
        "MEDIAMTX_WEBHOOK_SECRET and STREAM_TOKEN_SECRET together or not at all — see " +
        "apps/api/.env.example. Refusing to start rather than boot with streaming half-wired."
    );
  }

  if (isRelaxedNodeEnv(env.nodeEnv)) {
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] streaming provider: FakeStreamingAdapter " +
        "(MEDIAMTX_RTMP_HOST/MEDIAMTX_HLS_BASE_URL/MEDIAMTX_WHIP_BASE_URL/MEDIAMTX_WEBHOOK_SECRET/" +
        "STREAM_TOKEN_SECRET not set — no real MediaMTX will be used; set all five to switch to " +
        "MediaMtxAdapter)"
    );
    return new FakeStreamingAdapter();
  }

  logProviderChoice(
    env.nodeEnv,
    "[bootstrap] streaming provider: none — live streaming is DISABLED " +
      "(MEDIAMTX_RTMP_HOST/MEDIAMTX_HLS_BASE_URL/MEDIAMTX_WHIP_BASE_URL/MEDIAMTX_WEBHOOK_SECRET/" +
      `STREAM_TOKEN_SECRET not set, and NODE_ENV is ${describeNodeEnv(env.nodeEnv)}, outside ` +
      `${RELAXED_NODE_ENVS_LIST}). Unlike messaging this does NOT block boot: the ` +
      "creator's streaming UI stays hidden. Set all five env vars to enable it."
  );
  return undefined;
}

/** The five env vars that make up media storage configuration, for error text. */
const MEDIA_STORAGE_ENV_VAR_NAMES = {
  accessKeyId: "S3_ACCESS_KEY_ID",
  secretAccessKey: "S3_SECRET_ACCESS_KEY",
  bucket: "S3_BUCKET",
  endpoint: "S3_ENDPOINT",
  region: "S3_REGION",
} as const;

/**
 * Chooses where image bytes live (Task 2 of Phase 4's images work).
 *
 * Same five-vars-together shape as `selectStreamingProvider` above — all set,
 * or none, or it throws for being half-wired — but the ABSENT branch is
 * deliberately `selectMessagingProviders`'s shape, not `selectStreamingProvider`'s
 * or `selectPaymentProvider`'s:
 *
 *   1. All five set -> `S3MediaStorageAdapter`, in EVERY environment. Real
 *      bytes go to a real bucket.
 *   2. PARTIAL configuration (one to four set) throws in EVERY environment,
 *      same reasoning as every other half-configured guard in this file: an
 *      access key with no bucket is never intentional.
 *   3. ABSENT configuration selects `FakeMediaStorageAdapter` ONLY when
 *      `NODE_ENV` is in `RELAXED_NODE_ENVS` — the fake keeps bytes in a `Map`
 *      instead of a bucket.
 *   4. ABSENT configuration OUTSIDE the allowlist THROWS — it does NOT
 *      degrade the way `selectStreamingProvider`/`selectEmailProvider`/
 *      `selectPaymentProvider` do. This is the deliberate asymmetry: a
 *      disabled co-builder or a hidden "go live" button costs a creator a
 *      feature they can see is missing, but an upload endpoint that stays
 *      UP and silently keeps every image in process memory looks like it
 *      worked, loses every byte on the next restart or deploy, and gives
 *      nobody any signal that anything is wrong until a member reports a
 *      broken image. An API that refuses to start is a better failure than
 *      an API that quietly eats uploads — the same call `selectMessagingProviders`
 *      makes for an invite nobody can be told about.
 */
export function selectMediaStorage(env: {
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  bucket: string | undefined;
  endpoint: string | undefined;
  region: string | undefined;
  nodeEnv: string | undefined;
}): MediaStoragePort {
  const values = {
    accessKeyId: presentOrUndefined(env.accessKeyId),
    secretAccessKey: presentOrUndefined(env.secretAccessKey),
    bucket: presentOrUndefined(env.bucket),
    endpoint: presentOrUndefined(env.endpoint),
    region: presentOrUndefined(env.region),
  };
  const entries = Object.entries(values) as [keyof typeof values, string | undefined][];
  const setCount = entries.filter(([, value]) => value !== undefined).length;

  if (setCount === entries.length) {
    logProviderChoice(
      env.nodeEnv,
      `[bootstrap] media storage: S3MediaStorageAdapter (bucket ${values.bucket} at ` +
        `${values.endpoint}) — uploads are REAL`
    );
    return new S3MediaStorageAdapter({
      accessKeyId: values.accessKeyId as string,
      secretAccessKey: values.secretAccessKey as string,
      bucket: values.bucket as string,
      endpoint: values.endpoint as string,
      region: values.region as string,
    });
  }

  if (setCount > 0) {
    const present = entries
      .filter(([, value]) => value !== undefined)
      .map(([key]) => MEDIA_STORAGE_ENV_VAR_NAMES[key]);
    const missing = entries
      .filter(([, value]) => value === undefined)
      .map(([key]) => MEDIA_STORAGE_ENV_VAR_NAMES[key]);
    throw new Error(
      `Media storage is half-configured: ${present.join(", ")} set but ${missing.join(", ")} not. ` +
        "Set S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_ENDPOINT and S3_REGION " +
        "together or not at all — see apps/api/.env.example. Refusing to start rather than boot " +
        "with media storage half-wired."
    );
  }

  if (isRelaxedNodeEnv(env.nodeEnv)) {
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] media storage: FakeMediaStorageAdapter — uploads are kept IN MEMORY and " +
        "vanish on restart (S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET/S3_ENDPOINT/" +
        "S3_REGION not all set, and NODE_ENV is development/test). Set all five to store real " +
        "images."
    );
    return new FakeMediaStorageAdapter();
  }

  // BLOCK BOOT — see this function's own docstring, case 4, for why this is
  // deliberately NOT the same shape as selectStreamingProvider/selectEmailProvider
  // returning a disabled value instead.
  throw new Error(
    "S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET/S3_ENDPOINT/S3_REGION are not set, and " +
      `NODE_ENV is ${describeNodeEnv(env.nodeEnv)}. FakeMediaStorageAdapter is permitted ONLY ` +
      `when NODE_ENV is exactly ${RELAXED_NODE_ENVS_LIST}: it keeps uploaded bytes in a Map ` +
      "that vanishes on restart, so a box running it outside development/test would accept " +
      "uploads and silently drop every one of them — worse than refusing to start. Set all " +
      "five S3_* env vars — see apps/api/.env.example — or set NODE_ENV=development."
  );
}

/**
 * The token `resolveCallbackToken` hands back under `NODE_ENV=test`, and the
 * one value it refuses to accept anywhere else. It is committed to this
 * repository, so treating it as a real secret would mean shipping a publicly
 * known webhook password — the same failure mode as the `.env.example`
 * `JWT_SECRET` placeholder.
 */
export const TEST_CALLBACK_TOKEN = "test-callback-token";

/**
 * Resolves the static token that is the ONLY authentication on
 * `POST /webhooks/xendit`.
 *
 * Nothing read `XENDIT_CALLBACK_TOKEN` before Task 7, so it sat outside the
 * configuration guard above. It is now inside it, and deliberately shaped like
 * `selectPaymentProvider` rather than like `assertUsableJwtSecret` — same three
 * cases, same thresholds (owner ruling, 2026-08-09):
 *
 *   1. A configured token is used as-is. Empty and whitespace-only count as
 *      unset (`XENDIT_CALLBACK_TOKEN=` in a .env file arrives as `""`).
 *   2. PARTIAL configuration throws in EVERY environment. A box with
 *      XENDIT_SECRET_KEY and XENDIT_SPLIT_RULE_ID set is taking real money; if
 *      it cannot authenticate the callback that credits that money, no member
 *      it charges is ever activated. Same reasoning as the half-configured
 *      check in `selectPaymentProvider`, extended to the third variable.
 *   3. ABSENT configuration returns `undefined` when `NODE_ENV` is one of
 *      `RELAXED_NODE_ENVS`, OR when XENDIT_SECRET_KEY/XENDIT_SPLIT_RULE_ID are
 *      ALSO both absent — the free-communities addition: if `selectPaymentProvider`
 *      has already decided this box has no payment provider at all, no Xendit
 *      invoice will ever exist for this webhook to authenticate, so refusing to
 *      boot over a token for a callback that can never arrive would defeat the
 *      entire point of that `null` (see its own docstring). Throws for
 *      EVERYTHING else outside `RELAXED_NODE_ENVS` — a box with EITHER Xendit
 *      key set (which is real or half-configured, both handled above/below)
 *      still needs this token. A developer must be able to `bun run dev`
 *      without setting a variable for an endpoint they may never exercise
 *      locally, exactly as they can without the Xendit keys; nobody else gets
 *      that.
 *   4. A configured token shorter than `MIN_CALLBACK_TOKEN_LENGTH` throws in
 *      every environment, exactly as a short `JWT_SECRET` does.
 *
 * `undefined` is safe to return, and is why `verifyCallbackToken` takes
 * `string | undefined`: it refuses an unset or empty `expected` before any
 * comparison, so an unconfigured box rejects every webhook rather than
 * accepting every forged one. It fails closed — the guard exists so that
 * production fails LOUDLY instead.
 *
 * Plus one rule the JWT secret taught us: the test default is refused outside
 * tests, so `XENDIT_CALLBACK_TOKEN=test-callback-token` on a production box —
 * a value anyone can read in this file — cannot vouch for a payment.
 */
export function resolveCallbackToken(env: {
  callbackToken: string | undefined;
  secretKey: string | undefined;
  splitRuleId: string | undefined;
  nodeEnv: string | undefined;
}): string | undefined {
  const token = presentOrUndefined(env.callbackToken);

  if (token !== undefined) {
    if (token === TEST_CALLBACK_TOKEN) {
      if (env.nodeEnv !== "test") {
        throw new Error(
          "XENDIT_CALLBACK_TOKEN is the value committed to this repository for tests. " +
            "Anyone can read it, so it would authenticate a forged payment event. Use the " +
            "callback token from the Xendit dashboard."
        );
      }
      // Exempt from the length floor below: it is the suite's own known value,
      // and it is already refused everywhere else by the branch above.
      return token;
    }
    if (token.length < MIN_CALLBACK_TOKEN_LENGTH) {
      throw new Error(
        `XENDIT_CALLBACK_TOKEN is too short (${token.length} characters; ` +
          `${MIN_CALLBACK_TOKEN_LENGTH} required). It is the ONLY authentication on ` +
          "POST /webhooks/xendit, so a guessable value grants free access to every paid " +
          "community. Copy the full token from Settings → Developers → Webhooks in the " +
          "Xendit dashboard."
      );
    }
    return token;
  }

  // Checked before the production rule so the suite, which never sets the
  // variable, keeps working even when a test hands `selectPaymentProvider` a
  // fully-configured Xendit environment.
  if (env.nodeEnv === "test") {
    return TEST_CALLBACK_TOKEN;
  }

  if (presentOrUndefined(env.secretKey) && presentOrUndefined(env.splitRuleId)) {
    throw new Error(
      "Xendit is half-configured: XENDIT_SECRET_KEY and XENDIT_SPLIT_RULE_ID are set " +
        "but XENDIT_CALLBACK_TOKEN is not. Real invoices would be created and no " +
        "callback could be authenticated, so no member who paid would ever be " +
        "activated. Set all three — see apps/api/.env.example."
    );
  }

  if (!isRelaxedNodeEnv(env.nodeEnv)) {
    // Mirrors selectPaymentProvider's own disabled branch: if Xendit itself is
    // fully unconfigured, this box has no payment provider (selectPaymentProvider
    // already returned null for it), so there is no invoice this webhook could
    // ever be asked to authenticate. Throwing here anyway would refuse to boot a
    // box that free communities made genuinely payment-free — the exact outcome
    // selectPaymentProvider's null was introduced to avoid.
    if (!presentOrUndefined(env.secretKey) && !presentOrUndefined(env.splitRuleId)) {
      logProviderChoice(
        env.nodeEnv,
        "[bootstrap] XENDIT_CALLBACK_TOKEN not set — payments are disabled on this box " +
          "(XENDIT_SECRET_KEY/XENDIT_SPLIT_RULE_ID not set either, and NODE_ENV is " +
          `${describeNodeEnv(env.nodeEnv)}), so POST /webhooks/xendit will reject every ` +
          "delivery. This does not block boot."
      );
      return undefined;
    }

    throw new Error(
      "XENDIT_CALLBACK_TOKEN is not set, and NODE_ENV is " +
        `${describeNodeEnv(env.nodeEnv)}. Booting without it is permitted ONLY when ` +
        `NODE_ENV is exactly ${RELAXED_NODE_ENVS_LIST}. Add it to apps/api/.env — see ` +
        ".env.example, and copy the callback token from the Xendit dashboard — or set " +
        "NODE_ENV=development. Refusing to start rather than serving a webhook endpoint " +
        "that rejects every real payment."
    );
  }

  logProviderChoice(
    env.nodeEnv,
    "[bootstrap] XENDIT_CALLBACK_TOKEN not set — POST /webhooks/xendit will reject " +
      "every delivery. Set it to test the webhook path locally."
  );
  return undefined;
}

/**
 * The `APP_BASE_URL` a developer gets for free: Vite's default dev-server
 * origin, which is what `apps/web` serves the confirmation page from.
 */
export const DEFAULT_APP_BASE_URL = "http://localhost:5173";

/**
 * Resolves the public origin of `apps/web`, used to build the
 * `success_redirect_url` the payment provider sends the payer back to:
 * `<base>/c/<slug>/status/<subscriptionId>`.
 *
 * Same allowlist rule as the two guards above (see RELAXED_NODE_ENVS): the
 * localhost default is permitted only under `development`/`test`. Anywhere else
 * it must be set, because a deployment silently falling back to
 * `http://localhost:5173` sends every paying member to a page on their OWN
 * machine — a failure that looks like the payment vanished, and one no test on a
 * developer's laptop would ever surface.
 *
 * A trailing slash is stripped so callers can concatenate a rooted path without
 * producing `//c/...`.
 */
export function resolveAppBaseUrl(env: {
  appBaseUrl: string | undefined;
  nodeEnv: string | undefined;
}): string {
  const configured = presentOrUndefined(env.appBaseUrl);

  if (configured === undefined) {
    if (!isRelaxedNodeEnv(env.nodeEnv)) {
      throw new Error(
        "APP_BASE_URL is not set, and NODE_ENV is " +
          `${describeNodeEnv(env.nodeEnv)}. Falling back to ${DEFAULT_APP_BASE_URL} is ` +
          `permitted ONLY when NODE_ENV is exactly ${RELAXED_NODE_ENVS_LIST}: it is the ` +
          "URL the payment provider sends a paying member back to, so a localhost " +
          "default would strand every payer on their own machine. Add it to " +
          "apps/api/.env — see .env.example."
      );
    }
    return DEFAULT_APP_BASE_URL;
  }

  const trimmed = configured.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
    throw new Error(
      `APP_BASE_URL must start with https:// or http:// (got "${trimmed}"). It is ` +
        "concatenated into a URL the payment provider redirects a browser to."
    );
  }
  return trimmed;
}

/**
 * Silent under `NODE_ENV=test` only. `bootstrap()` is called once per test that
 * builds an app, so this line printed 100+ times in one suite run and buried a
 * genuine `unhandled error` line. Everywhere else it still prints: the guards
 * above are the safety mechanism, but an operator reading startup output should
 * still see which adapter is live.
 */
function logProviderChoice(nodeEnv: string | undefined, message: string): void {
  if (nodeEnv === "test") return;
  console.log(message);
}

export function bootstrap(): Dependencies {
  const jwtSecret = assertUsableJwtSecret(process.env.JWT_SECRET);

  const passwordHasher = new BunPasswordHasher();

  // Phase 9's personal accounts, and since retire-telegram Task 7's fix round
  // the ONLY accounts. This block used to be preceded by four lines building
  // the creator identity `/auth` served — a `DrizzleCreatorRepository`, a
  // second `HonoJwtTokenIssuer` on this same `jwtSecret`, `RegisterCreator`
  // and `AuthenticateCreator`. Task 1 deleted the dashboard that was their
  // only caller; the fix round deleted the routes, the use cases, the
  // repository, both ports and the creator `requireAuth` middleware behind
  // them.
  //
  // `passwordHasher` above is SHARED and stays: `RegisterUser` and
  // `AuthenticateUser` need it exactly as the creator pair did.
  //
  // ONE `typ` CLAIM, STILL CHECKED. `HonoJwtUserTokenIssuer` stamps and
  // verifies `typ: "user"`; it was what kept two audiences on one `JWT_SECRET`
  // apart, and with one audience left it is what stops any OTHER token signed
  // with this secret from being accepted as a session. See that class's own
  // docstring, and `user-auth.middleware.test.ts`, which now forges the
  // creator-shaped token it used to mint.
  const userRepository = new DrizzleUserRepository(db);
  // Phase 5a. Its own repository over the same table — see the port's docstring
  // for why the payout column is not on `userRepository`.
  const userPayoutRepository = new DrizzleUserPayoutRepository(db);
  // Task 1. `user_tier` — another own-table repository beside the two above.
  const userTierRepository = new DrizzleUserTierRepository(db);
  const userTokenIssuer = new HonoJwtUserTokenIssuer(jwtSecret);
  // `registerUser` is constructed further down, alongside Task 5's password
  // reset — see the comment there for why it needs to wait for `messaging`.
  const authenticateUser = new AuthenticateUser(userRepository, passwordHasher, userTokenIssuer);
  // Task 2 (profiles and following). Constructed here, before `getUserProfile`,
  // because `GetUserProfile` now needs it too (`viewerFollows` and the two
  // counts on the public profile) — one repository, three consumers.
  const followRepository = new DrizzleFollowRepository(db);
  // ONE clock for the process. Phase 5's use-cases read time through it rather than
  // calling `Date.now()`, so the renewal window and the settlement date a member's next
  // period is measured from are both observable in a test.
  //
  // Constructed HERE, further up than it used to be, because Task 10's
  // `isMemberOf` (just below) needs it and `getUserProfile` needs that. Its
  // other consumers are all further down and unaffected — one instance, same
  // as before.
  const clock = new SystemClock();
  // `user_subscription`/`user_transaction`. Task 6 built it for
  // `startUserSubscription` alone; Task 10 gives it a SECOND consumer that
  // exists whether or not this deployment has a payment provider, which is why
  // it is constructed unconditionally and up here rather than beside that
  // use-case.
  const userSubscriptionRepository = new DrizzleUserSubscriptionRepository(db);
  /**
   * Task 8's use-case, on a request path at last (Task 10).
   *
   * Phase 6's paywall is founded on this question and nothing in 5a called it
   * — a use-case wired to no route is one nothing proves end to end. The
   * public profile now asks it for every signed-in viewer, which is also the
   * shape Phase 6 will use: `status = 'active'` AND `current_period_end >
   * now`, one indexed read.
   */
  const isMemberOf = new IsMemberOf(userSubscriptionRepository, clock);
  // Task 6 of Phase 5b (spec §8). `isMemberOf` above is untouched — this is a
  // SEPARATE use-case over the same repository, mirroring its "currently
  // subscribed" definition rather than calling it, because this one answers a
  // per-owner LIST and `isMemberOf` answers a per-pair question. See
  // `ListSubscribers`'s own docstring.
  const listSubscribers = new ListSubscribers(userSubscriptionRepository, clock);
  // Task 5 of "free memberships": the SAME `userSubscriptionRepository`
  // `isMemberOf` and `listSubscribers` read — no separate repository, no
  // separate clock (approving/rejecting never compares against `now`).
  const membershipRequests = new MembershipRequests(userSubscriptionRepository);
  const revokeMembership = new RevokeMembership(userRepository, userSubscriptionRepository);
  const leaveMembership = new LeaveMembership(userRepository, userSubscriptionRepository);
  // Task 5 of memberships-5a: `userTierRepository` (constructed above, Task 1)
  // is now GetUserProfile's third dependency too — the public profile's
  // `membership.tiers` read. Task 10 adds the fourth, `isMemberOf`, for the
  // same payload's `viewerIsMember`. Task 6 of "free memberships" adds the
  // fifth, the SAME `userSubscriptionRepository` `isMemberOf` reads, for
  // `membership.viewerRequestPending`.
  const getUserProfile = new GetUserProfile(
    userRepository,
    followRepository,
    userTierRepository,
    isMemberOf,
    userSubscriptionRepository
  );
  const updateUserProfile = new UpdateUserProfile(userRepository);
  const followUser = new FollowUser(userRepository, followRepository);
  const listFollows = new ListFollows(userRepository, followRepository);
  // Task 3 (Jelajah). The three READ methods live on `userRepository` —
  // `searchPublic`/`newestPublic`/`mostFollowedPublic` all query `app_user`
  // directly (the follower count join lives inside
  // `DrizzleUserRepository.mostFollowedPublic`). `followRepository` is here for
  // ONE further thing, added by the final review's item 1: the per-row
  // `viewerFollows` on all three lists, resolved in one query for the whole
  // screen — see `resolveViewerFollowSet`.
  const exploreUsers = new ExploreUsers(userRepository, followRepository);

  // Phase 1 (communities-core). One repository, five use cases — the same
  // shape `followRepository` above and `postRepository` below both have.
  // `createCommunity` and `getCommunity` take `userRepository` too: the
  // detail response carries the owner's handle and display name, which live
  // on `app_user` and not on `community`.
  const communityRepository = new DrizzleCommunityRepository(db);
  const createCommunity = new CreateCommunity(userRepository, communityRepository);
  const getCommunity = new GetCommunity(userRepository, communityRepository);
  const joinCommunity = new JoinCommunity(communityRepository);
  const browseCommunities = new BrowseCommunities(communityRepository);
  const listCommunityMembers = new ListCommunityMembers(communityRepository);

  // Task 2 of posts-and-feed. One repository, five use cases — mirrors
  // `followRepository`'s shape just above.
  //
  // Phase 4 Task 6: four of the five now also take `mediaRepository`, because
  // a post carries its images (`media` on every post view), a create or edit
  // claims them, and an edit unclaims what it dropped. It is constructed HERE
  // rather than beside `uploadMedia` further down — it needs nothing but `db`,
  // and these use cases are built before media storage is even selected.
  const mediaRepository = new DrizzleMediaRepository(db);
  const postRepository = new DrizzlePostRepository(db);
  // Task 7 of images: resolved UNCONDITIONALLY, unlike
  // `resolveAiDailyMessageLimit` (gated behind `aiProvider` further below) —
  // posting is a core feature on every box, so a malformed `MAX_POST_IMAGES`
  // must fail boot everywhere, not just where some optional feature happens
  // to be enabled.
  const maxPostImages = resolveMaxPostImages(process.env.MAX_POST_IMAGES);
  // Task 5 fix rounds 1 and 2: the post write and the media claim run in ONE
  // transaction, for `CreatePost` and `EditPost` alike (`EditPost` also locks
  // the row first) — see `PostWriteUnitOfWorkPort`'s own docstring for the
  // paths that left a members-only post with zero images before this
  // existed on each side. ONE instance, shared by both, the same way
  // `postRepository`/`mediaRepository` above are.
  const postWriteUnitOfWork = new DrizzlePostWriteUnitOfWork(db);
  const createPost = new CreatePost(postWriteUnitOfWork);
  const editPost = new EditPost(postWriteUnitOfWork);
  const deletePost = new DeletePost(postRepository, communityRepository);
  // The SAME `userSubscriptionRepository` and the SAME `clock` `isMemberOf`
  // and `listSubscribers` read, so the paywall gate cannot disagree with the
  // rest of the product about who is a member or about what time it is.
  const listFeed = new ListFeed(postRepository, mediaRepository, userSubscriptionRepository, clock);
  const listUserPosts = new ListUserPosts(
    userRepository,
    postRepository,
    mediaRepository,
    userSubscriptionRepository,
    clock
  );
  // BARRIER TWO (spec §6.2), built from the very same four collaborators the
  // feed's gate above reads — the same `userSubscriptionRepository` and the
  // same `clock` as `isMemberOf`, `listSubscribers` and `listFeed`. Two
  // barriers answering to two different membership sources is the one way this
  // phase could be green in tests and wrong in production.
  const mediaEntitlement = new MediaEntitlement(
    mediaRepository,
    postRepository,
    userSubscriptionRepository,
    clock
  );

  const payments: PaymentProviderPort | null = selectPaymentProvider({
    secretKey: process.env.XENDIT_SECRET_KEY,
    splitRuleId: process.env.XENDIT_SPLIT_RULE_ID,
    nodeEnv: process.env.NODE_ENV,
  });

  // Task 4. Resolved here rather than down with `messaging` below: nothing in
  // THIS task's `Dependencies` depends on it (Task 5's `RequestPasswordReset`
  // is the first consumer), so its position is not load-bearing.
  const email: EmailProviderPort | null = selectEmailProvider({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM,
    nodeEnv: process.env.NODE_ENV,
  });

  // Phase 5a's payout flow for `app_user`, and the only one left: the
  // creator-scoped `CreatePaymentAccount`/`GetPaymentAccountStatus` pair that
  // stood here went with `POST|GET /payment-account` in retire-telegram
  // Task 7's fix round. `undefined` EXACTLY when `payments` is `null` — see
  // `connectUserPayout`'s own field docstring on `Dependencies`. The STATUS
  // reader below is always constructed, because a box with payments disabled
  // must still be able to answer the question.
  //
  // `PaymentProviderPort.createPaymentAccount` — the ADAPTER method both the
  // deleted use case and this one call — is untouched, and so is every
  // adapter implementing it.
  const connectUserPayout = payments
    ? new ConnectUserPayout(userPayoutRepository, payments)
    : undefined;
  const getUserPayoutStatus = new GetUserPayoutStatus(userPayoutRepository);
  // Task 4 of Phase 5a. Needs no `PaymentProviderPort` — only the payout
  // column's current state — so unlike `connectUserPayout` it is constructed
  // unconditionally, the same reasoning `getUserPayoutStatus` above follows.
  const manageUserTiers = new ManageUserTiers(userTierRepository, userPayoutRepository);
  // After selectPaymentProvider on purpose — two reasons, one of them dated.
  //
  // STILL TRUE: `connectUserPayout` above needs `payments` already resolved,
  // so this call has to happen no later than it does regardless of anything
  // below it. (Retire-telegram Task 4 deleted `createCommunity`/
  // `updateCommunity`, which shared that constraint; Task 7's fix round
  // deleted `createPaymentAccount`, which this sentence used to name.)
  //
  // NO LONGER TRUE (fix round 1 correction): this comment used to say the order
  // matters because "you are about to take fake money" is the more urgent of two
  // COMPETING throw messages, and that an existing test pinned that wording. Free
  // communities removed that competition: `selectPaymentProvider` and
  // `resolveCallbackToken` no longer have any input combination where BOTH would
  // throw for this process to choose between (see each function's own
  // docstring — resolveCallbackToken's own disabled branch mirrors
  // selectPaymentProvider's null exactly, for exactly the absent-Xendit case that
  // used to race here). No test today asserts an ordering between these two
  // functions' messages, because there is no longer a message to race.
  const xenditCallbackToken = resolveCallbackToken({
    callbackToken: process.env.XENDIT_CALLBACK_TOKEN,
    secretKey: process.env.XENDIT_SECRET_KEY,
    splitRuleId: process.env.XENDIT_SPLIT_RULE_ID,
    nodeEnv: process.env.NODE_ENV,
  });

  const appBaseUrl = resolveAppBaseUrl({
    appBaseUrl: process.env.APP_BASE_URL,
    nodeEnv: process.env.NODE_ENV,
  });
  // Task 6 of Phase 5a, changed by Task 4 of "free memberships". NO LONGER
  // gated on `payments`: a FREE tier needs no provider at all, and gating the
  // whole use case on `payments` made `POST /users/:handle/subscribe` 503 on
  // a payments-disabled box regardless of the tier's price — the actual
  // production deployment right now. `payments` is passed straight through,
  // `null` and all: the use case refuses a PAID tier itself when `payments`
  // is `null` (see `StartUserSubscription`'s own docstring), so the decision
  // moved from BOOT time here to the TIER, at request time.
  const startUserSubscription = new StartUserSubscription(
    userRepository,
    userTierRepository,
    userPayoutRepository,
    userSubscriptionRepository,
    // Retiring a lapsed membership and claiming this pair's pending slot in
    // ONE transaction — Phase 5b, Task 2. See `UserPurchaseUnitOfWorkPort`
    // for the "neither active nor pending" state a split commit leaves.
    new DrizzleUserPurchaseUnitOfWork(db),
    payments,
    // The SAME clock `isMemberOf` above reads, so the two cannot disagree
    // about whether a subscription's period has passed — the divergence
    // between them is precisely what the final review's I1 was about.
    clock,
    { appBaseUrl }
  );

  // The streaming signing secret. Read directly off `process.env` here (rather
  // than derived from `streamingProvider`'s truthiness) for the exact reason
  // `mediamtxWebhookSecret` does this further down: by the
  // time `selectStreamingProvider` (below) has run without throwing, either
  // all five streaming vars are set and length-valid or all five are
  // genuinely absent — so a plain `presentOrUndefined` read here is exactly
  // as strict, without this file's several selectors needing to agree about
  // what "configured" means. Declared before `selectStreamingProvider` is
  // even called is safe: a half-configured box makes that call throw before
  // this function ever returns anything, so nothing constructed off this
  // value here is ever handed to a caller in that case.
  const streamTokenSecret = presentOrUndefined(process.env.STREAM_TOKEN_SECRET);

  // The webhook's writes commit together or not at all — see
  // PaymentActivationUnitOfWorkPort. The reads that precede them use the
  // pooled repository directly.
  const paymentActivationUnitOfWork = new DrizzlePaymentActivationUnitOfWork(db);
  const handlePaymentWebhook = new HandlePaymentWebhook(
    // The ONLY kind of invoice this codebase mints. Xendit still delivers one
    // shared webhook stream to one public endpoint, so `external_id` is still
    // routed on the `usub_` namespace and never guessed — an id that is not in
    // it is ignored rather than resolved here (see `domain/user-payment.ts`).
    // Retire-telegram Task 5 removed the community half and, with it, this
    // constructor's community subscription-repository argument; Task 6 deleted
    // that port and its implementation outright.
    userSubscriptionRepository,
    paymentActivationUnitOfWork,
    clock
  );

  // What this process still messages people about: Task 5's password reset and
  // its existing-email signup notice. (Revocation used to be the first of these,
  // and granting has always happened in apps/worker.) Same allowlist as the
  // payment adapter: on a box with no token and a NODE_ENV outside the allowlist
  // this throws rather than booting a fake that would report a send it never
  // performed.
  const messaging = selectMessagingProviders({
    fonnteApiToken: process.env.FONNTE_API_TOKEN,
    nodeEnv: process.env.NODE_ENV,
  });

  // Phase 4's image storage (Task 2). Positioned here, right after messaging,
  // because it shares messaging's block-boot shape (see `selectMediaStorage`'s
  // own docstring) rather than payments'/email's/streaming's disabled-instead
  // shape — both guards refuse to let this process come up looking like it
  // works while quietly failing the thing a paying member or a posting user
  // is relying on.
  const mediaStorage: MediaStoragePort = selectMediaStorage({
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucket: process.env.S3_BUCKET,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    nodeEnv: process.env.NODE_ENV,
  });

  // Task 4's `POST /users/media`. `mediaRepository` itself is constructed up
  // with `postRepository` (Task 6 needs it there); this is where it meets
  // `mediaStorage`, the use case's other dependency. The SAME instance backs
  // Task 5's delivery routes, which look a row up by id.
  const uploadMedia = new UploadMedia(mediaRepository, mediaStorage);

  // Task 5's password reset, and `registerUser`'s existing-email notice.
  // Constructed HERE, not up with `userRepository`/`authenticateUser` above,
  // because both need `messaging.notifier` (just resolved) and `email`/
  // `appBaseUrl`/`clock` (resolved earlier, but this is the first point all
  // four are available together).
  const passwordResetRepository = new DrizzlePasswordResetRepository(db);
  const passwordResetUnitOfWork = new DrizzlePasswordResetUnitOfWork(db);
  // Review finding F3's rate-limit ledger for `registerUser`'s
  // existing-email notice — a separate table/repository from
  // `passwordResetRepository` on purpose, so exhausting one cannot starve
  // the other. See `signupNotices` in db/schema.ts.
  const signupNoticeRepository = new DrizzleSignupNoticeRepository(db);
  const registerUser = new RegisterUser(
    userRepository,
    passwordHasher,
    email,
    messaging.notifier,
    signupNoticeRepository,
    clock
  );
  const requestPasswordReset = new RequestPasswordReset(
    userRepository,
    passwordResetRepository,
    email,
    messaging.notifier,
    clock,
    { appBaseUrl }
  );
  const completePasswordReset = new CompletePasswordReset(
    passwordResetRepository,
    passwordHasher,
    passwordResetUnitOfWork,
    clock
  );

  // Task 2's live-streaming provider. The SECOND feature in this codebase
  // that boots disabled rather than refusing to start — see
  // selectStreamingProvider.
  const streamingProvider = selectStreamingProvider({
    rtmpHost: process.env.MEDIAMTX_RTMP_HOST,
    hlsBaseUrl: process.env.MEDIAMTX_HLS_BASE_URL,
    whipBaseUrl: process.env.MEDIAMTX_WHIP_BASE_URL,
    webhookSecret: process.env.MEDIAMTX_WEBHOOK_SECRET,
    streamTokenSecret: process.env.STREAM_TOKEN_SECRET,
    nodeEnv: process.env.NODE_ENV,
  });

  // Task 3 of Phase 7 — the user-scoped streaming world, and after
  // retire-telegram Task 3 the only one left. `userStreamRepository` is
  // constructed here and shared by all of its use-cases rather than exposed on
  // `Dependencies`, the same rule `eventRepository` above follows.
  const userStreamRepository = new DrizzleUserStreamRepository(db);
  // Gated on `streamingProvider`: the constructor requires a real provider, and
  // "is streaming configured" is this file's decision, not the use-case's.
  const startUserStream = streamingProvider
    ? new StartUserStream(userStreamRepository, streamingProvider)
    : undefined;
  // NOT gated, and not even handed a `streamingProvider | undefined` — see the
  // field docstrings above. The SAME
  // `userSubscriptionRepository` and the SAME `clock` `isMemberOf` and
  // `listFeed` read, so Siaran's gate and the feed's gate cannot disagree
  // about who is a paying member at a given instant.
  const listLiveStreams = new ListLiveStreams(
    userStreamRepository,
    userSubscriptionRepository,
    clock
  );
  const endOwnUserStream = new EndOwnUserStream(userStreamRepository, clock);

  // Task 4's publish/read authorisation. The webhook secret is read directly
  // here rather than re-derived from `streamingProvider`'s truthiness, and
  // `streamTokenSecret` itself was already resolved earlier — see that
  // declaration for why reading it before `selectStreamingProvider` runs is
  // still safe. Both secrets rely on the
  // SAME invariant `selectStreamingProvider` enforces: by the time execution
  // reaches this line, either both MEDIAMTX_WEBHOOK_SECRET and
  // STREAM_TOKEN_SECRET are set and length-valid (the five-vars-together
  // branch), or both are genuinely absent (partial configuration threw
  // already) — so a plain `presentOrUndefined` read is exactly as strict as
  // re-checking `streamingProvider`, without depending on this file's several
  // selectors agreeing forever about what "configured" means.
  const mediamtxWebhookSecret = presentOrUndefined(process.env.MEDIAMTX_WEBHOOK_SECRET);
  const authoriseStream = streamTokenSecret
    ? new AuthoriseStream(userStreamRepository, { streamTokenSecret })
    : undefined;

  // Task 5's mint endpoint. `undefined` in lockstep with `authoriseStream`
  // above (both need only `STREAM_TOKEN_SECRET`), and handed the SAME
  // `isMemberOf` the public profile and the feed already ask — so Siaran's
  // paywall, the profile's `viewerIsMember` and the feed's lock cannot
  // disagree about who is a paying member at a given instant. `isMemberOf`
  // itself is untouched by this task (spec §10).
  const mintUserWatchToken = streamTokenSecret
    ? new MintUserWatchToken(userStreamRepository, isMemberOf, clock, { streamTokenSecret })
    : undefined;

  // `POST /webhooks/mediamtx/lifecycle`'s only remaining decision logic, now that
  // retire-telegram Task 3 deleted `HandleStreamLifecycle` and the community world
  // it served. `userStreamRepository` is the SAME pooled instance
  // `startUserStream`/`listLiveStreams`/`endOwnUserStream` already share — this class
  // needs no transaction of its own, because `user_stream`'s `endById` is a single
  // atomic UPDATE with nothing else to commit alongside it (no activity_log row, no
  // per-member notify).
  //
  // Gated on `mediamtxWebhookSecret` rather than constructed unconditionally — see
  // the `endUserStream` field's own docstring for why that is a symmetry choice with
  // the route it serves, not a real dependency of the class.
  const endUserStream = mediamtxWebhookSecret
    ? new EndUserStream(userStreamRepository, clock)
    : undefined;

  return {
    payments,
    email,
    userRepository,
    userPayoutRepository,
    userTierRepository,
    userTokenIssuer,
    registerUser,
    authenticateUser,
    getUserProfile,
    updateUserProfile,
    followUser,
    listFollows,
    exploreUsers,
    communityRepository,
    createCommunity,
    getCommunity,
    joinCommunity,
    browseCommunities,
    listCommunityMembers,
    createPost,
    maxPostImages,
    editPost,
    deletePost,
    listFeed,
    listUserPosts,
    requestPasswordReset,
    completePasswordReset,
    connectUserPayout,
    getUserPayoutStatus,
    manageUserTiers,
    startUserSubscription,
    listSubscribers,
    membershipRequests,
    revokeMembership,
    leaveMembership,
    handlePaymentWebhook,
    messaging,
    xenditCallbackToken,
    appBaseUrl,
    sql,
    streamingProvider,
    startUserStream,
    listLiveStreams,
    endOwnUserStream,
    mintUserWatchToken,
    authoriseStream,
    mediamtxWebhookSecret,
    endUserStream,
    mediaStorage,
    uploadMedia,
    mediaRepository,
    mediaEntitlement,
  };
}
