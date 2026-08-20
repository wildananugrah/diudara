import { db, sql } from "./db/client";
import { DrizzleCreatorRepository } from "./infrastructure/repositories/drizzle-creator.repository";
import { DrizzleUserRepository } from "./infrastructure/repositories/drizzle-user.repository";
import { DrizzleUserPayoutRepository } from "./infrastructure/repositories/drizzle-user-payout.repository";
import { DrizzleCommunityRepository } from "./infrastructure/repositories/drizzle-community.repository";
import { BunPasswordHasher } from "./infrastructure/auth/bun-password.hasher";
import { HonoJwtTokenIssuer } from "./infrastructure/auth/hono-jwt.token-issuer";
import { HonoJwtUserTokenIssuer } from "./infrastructure/auth/hono-jwt.user-token-issuer";
import { RegisterCreator } from "./application/use-cases/register-creator";
import { AuthenticateCreator } from "./application/use-cases/authenticate-creator";
import { RegisterUser } from "./application/use-cases/register-user";
import { AuthenticateUser } from "./application/use-cases/authenticate-user";
import { GetUserProfile } from "./application/use-cases/get-user-profile";
import { IsMemberOf } from "./application/use-cases/is-member-of";
import { UpdateUserProfile } from "./application/use-cases/update-user-profile";
import { FollowUser, ListFollows } from "./application/use-cases/follow-user";
import { ExploreUsers } from "./application/use-cases/explore-users";
import { DrizzleFollowRepository } from "./infrastructure/repositories/drizzle-follow.repository";
import { DrizzlePostRepository } from "./infrastructure/repositories/drizzle-post.repository";
import { CreatePost, DeletePost, EditPost } from "./application/use-cases/write-post";
import { DrizzleMediaRepository } from "./infrastructure/repositories/drizzle-media.repository";
import { UploadMedia } from "./application/use-cases/upload-media";
import { ListFeed, ListUserPosts } from "./application/use-cases/read-posts";
import { RequestPasswordReset } from "./application/use-cases/request-password-reset";
import { CompletePasswordReset } from "./application/use-cases/complete-password-reset";
import { DrizzlePasswordResetRepository } from "./infrastructure/repositories/drizzle-password-reset.repository";
import { DrizzlePasswordResetUnitOfWork } from "./infrastructure/repositories/drizzle-password-reset-unit-of-work";
import { DrizzleSignupNoticeRepository } from "./infrastructure/repositories/drizzle-signup-notice.repository";
import { CreateCommunity } from "./application/use-cases/create-community";
import { ListCommunities } from "./application/use-cases/list-communities";
import { UpdateCommunity } from "./application/use-cases/update-community";
import { GetCommunity } from "./application/use-cases/get-community";
import { DrizzleMembershipTierRepository } from "./infrastructure/repositories/drizzle-membership-tier.repository";
import {
  DefineMembershipTier,
  ListTiers,
  UpdateTier,
} from "./application/use-cases/manage-tiers";
import { DrizzleChannelRepository } from "./infrastructure/repositories/drizzle-channel.repository";
import { ConnectChannel, ListChannels } from "./application/use-cases/manage-channels";
import { CreatePaymentAccount } from "./application/use-cases/create-payment-account";
import { GetPaymentAccountStatus } from "./application/use-cases/get-payment-account-status";
import { ConnectUserPayout } from "./application/use-cases/connect-user-payout";
import { GetUserPayoutStatus } from "./application/use-cases/get-user-payout-status";
import { DrizzleUserTierRepository } from "./infrastructure/repositories/drizzle-user-tier.repository";
import { ManageUserTiers } from "./application/use-cases/manage-user-tiers";
import { DrizzleUserSubscriptionRepository } from "./infrastructure/repositories/drizzle-user-subscription.repository";
import { StartUserSubscription } from "./application/use-cases/start-user-subscription";
import { GetPublicCommunity } from "./application/use-cases/get-public-community";
import { StartCheckout } from "./application/use-cases/start-checkout";
import { GetJoinRequestStatus, RequestToJoin } from "./application/use-cases/request-to-join";
import { DecideJoinRequest, ListJoinRequests } from "./application/use-cases/decide-join-request";
import { DrizzleJoinRequestRepository } from "./infrastructure/repositories/drizzle-join-request.repository";
import { DrizzleJoinRequestUnitOfWork } from "./infrastructure/repositories/drizzle-join-request-unit-of-work";
import { GetSubscriptionStatus } from "./application/use-cases/get-subscription-status";
import { HandlePaymentWebhook } from "./application/use-cases/handle-payment-webhook";
import { RevokeChannelAccess } from "./application/use-cases/revoke-channel-access";
import { RecordChannelJoin } from "./application/use-cases/record-channel-join";
import { SendRenewalReminder } from "./application/use-cases/send-renewal-reminder";
import { FakePaymentAdapter } from "./infrastructure/payments/fake-payment.adapter";
import { XenditPaymentAdapter } from "./infrastructure/payments/xendit-payment.adapter";
import { FakeEmailAdapter } from "./infrastructure/email/fake-email.adapter";
import { ResendEmailAdapter } from "./infrastructure/email/resend-email.adapter";
import { DrizzleMemberRepository } from "./infrastructure/repositories/drizzle-member.repository";
import { DrizzleSubscriptionRepository } from "./infrastructure/repositories/drizzle-subscription.repository";
import { DrizzlePaymentActivationUnitOfWork } from "./infrastructure/repositories/drizzle-payment-activation.unit-of-work";
import { DrizzleChannelMembershipRepository } from "./infrastructure/repositories/drizzle-channel-membership.repository";
import { DrizzleActivityLogRepository } from "./infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleAnalyticsRepository } from "./infrastructure/repositories/drizzle-analytics.repository";
import { GetCommunityMetrics } from "./application/use-cases/get-community-metrics";
import { GetCommunityActivity } from "./application/use-cases/get-community-activity";
import { ListCommunityMembers } from "./application/use-cases/list-community-members";
import { ExportCommunityMembers } from "./application/use-cases/export-community-members";
import { DrizzleOutboxRepository } from "./infrastructure/repositories/drizzle-outbox.repository";
import { SystemClock } from "./infrastructure/clock/system.clock";
import { FakeMessagingAdapter } from "./infrastructure/messaging/fake-messaging.adapter";
import { FonnteWhatsAppAdapter } from "./infrastructure/messaging/fonnte-whatsapp.adapter";
import { TelegramBotAdapter } from "./infrastructure/messaging/telegram-bot.adapter";
import { FAKE_AI_BEHAVIOURS, FakeAiAdapter, type FakeAiBehaviour } from "./infrastructure/ai/fake-ai.adapter";
import { OpenRouterAiAdapter } from "./infrastructure/ai/openrouter-ai.adapter";
import { DrizzleAiConversationRepository } from "./infrastructure/repositories/drizzle-ai-conversation.repository";
import { DrizzleAiUsageRepository } from "./infrastructure/repositories/drizzle-ai-usage.repository";
import { SendAiMessage } from "./application/use-cases/send-ai-message";
import { MediaMtxAdapter } from "./infrastructure/streaming/mediamtx.adapter";
import { FakeStreamingAdapter } from "./infrastructure/streaming/fake-streaming.adapter";
import { DrizzleEventRepository } from "./infrastructure/repositories/drizzle-event.repository";
import { DrizzleStreamLifecycleUnitOfWork } from "./infrastructure/repositories/drizzle-stream-lifecycle.unit-of-work";
import { ScheduleLiveSession, ListLiveSessions } from "./application/use-cases/schedule-live-session";
import { AuthoriseStream } from "./application/use-cases/authorise-stream";
import { HandleStreamLifecycle } from "./application/use-cases/handle-stream-lifecycle";
import { ResolveWatchToken } from "./application/use-cases/resolve-watch-token";
import { FakeMediaStorageAdapter } from "./infrastructure/storage/fake-media-storage.adapter";
import { S3MediaStorageAdapter } from "./infrastructure/storage/s3-media-storage.adapter";
import type { MessagingProviderPort } from "./application/ports/messaging-provider.port";
import type { MediaStoragePort } from "./application/ports/media-storage.port";
import type { MediaRepositoryPort } from "./application/ports/media-repository.port";
import type { CreatorRepositoryPort } from "./application/ports/creator-repository.port";
import type { UserRepositoryPort } from "./application/ports/user-repository.port";
import type { UserPayoutRepositoryPort } from "./application/ports/user-payout-repository.port";
import type { UserTierRepositoryPort } from "./application/ports/user-tier-repository.port";
import type { TokenIssuerPort } from "./application/ports/token-issuer.port";
import type { UserTokenIssuerPort } from "./application/ports/user-token-issuer.port";
import type { PaymentProviderPort } from "./application/ports/payment-provider.port";
import type { EmailProviderPort } from "./application/ports/email-provider.port";
import type { AiProviderPort } from "./application/ports/ai-provider.port";
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
  creatorRepository: CreatorRepositoryPort;
  tokenIssuer: TokenIssuerPort;
  /**
   * The payment adapter THIS process selected — `null` when
   * `selectPaymentProvider` decided the box has no payment provider at all
   * (see that function's own docstring). Exposed for the same reason
   * `messaging`/`aiProvider` are: a test must be able to prove what a given
   * environment actually wired. `null` here is why `startCheckout` and
   * `createPaymentAccount` below are themselves optional — there is nothing
   * to construct either against.
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
  registerCreator: RegisterCreator;
  authenticateCreator: AuthenticateCreator;
  /**
   * Phase 9's personal-account identity, distinct from `creatorRepository`
   * above. Exposed here for the same reason `creatorRepository` is: a test
   * must be able to seed/read `app_user` rows through the port rather than
   * poking Drizzle directly.
   */
  userRepository: UserRepositoryPort;
  /**
   * Phase 5a's payout column on `app_user`, kept off `userRepository` so that
   * `UserRecord` — which is projected straight into profile responses — never
   * carries a provider account id. Exposed here for the same reason
   * `creatorRepository` is: a test must be able to put the column into its
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
   * Signs and verifies user-session tokens. A SEPARATE class from
   * `tokenIssuer` even though both share `JWT_SECRET` — see
   * `HonoJwtUserTokenIssuer`'s own docstring for why the `typ` claim, not a
   * different secret, is what keeps the two session kinds apart.
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
  createCommunity: CreateCommunity;
  listCommunities: ListCommunities;
  updateCommunity: UpdateCommunity;
  /**
   * `GET /communities/:id` (Phase 7 carry-forward from Phase 6). Creator-scoped
   * through `CommunityRepositoryPort.findByIdForCreator` — the same method
   * `UpdateCommunity` uses — so a stranger's id 404s rather than 403ing and
   * confirming the resource exists.
   */
  getCommunity: GetCommunity;
  defineTier: DefineMembershipTier;
  listTiers: ListTiers;
  updateTier: UpdateTier;
  connectChannel: ConnectChannel;
  listChannels: ListChannels;
  /**
   * `POST /payment-account`. `undefined` EXACTLY when `payments` is `null` —
   * mirrors `sendAiMessage`'s undefined-ness: there is no `PaymentProviderPort`
   * to construct this against when payments are disabled, so connecting a
   * creator to one makes no sense on this box. `routes/payment-account.ts`
   * checks this the same way `routes/ai.ts` checks `sendAiMessage` and answers
   * 503 rather than crashing on a null provider it was never handed.
   */
  createPaymentAccount: CreatePaymentAccount | undefined;
  /**
   * `GET /payment-account` (Phase 7 carry-forward from Phase 6): whether the
   * AUTHENTICATED creator has connected payments, read from
   * `creator.xendit_account_id` through the same `isConnectedPaymentAccount` /
   * `isProvisioningPlaceholder` predicates `CreatePaymentAccount` uses. Read-only
   * and safe to call on every dashboard load — unlike the POST route above, it
   * provisions nothing at Xendit. Replaces the dashboard's per-browser
   * `localStorage` guess (see apps/web's `paymentAccount.ts`) with the server's
   * own truth. NOT read by the AI co-builder's model path — `SendAiMessage`
   * has no dependency on this and the system prompt never mentions it; only
   * the SCREEN reads it, via `PaymentAccountNotice` rendered above the
   * co-builder chat (`CoBuilderPage.tsx`), so a creator sees the warning
   * without the model itself being aware payments are connected or not.
   */
  getPaymentAccountStatus: GetPaymentAccountStatus;
  /**
   * `POST /users/me/payout` (Phase 5a). `undefined` EXACTLY when `payments` is
   * `null`, mirroring `createPaymentAccount` above: there is no
   * `PaymentProviderPort` to construct it against on a box with payments
   * disabled, and `routes/users.ts` answers 503 rather than crashing on a
   * provider it was never handed.
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
   * moves on a personal profile. `undefined` EXACTLY when `payments` is `null`,
   * mirroring `connectUserPayout` and `startCheckout`: there is no
   * `PaymentProviderPort` to construct it against on a box with payments
   * disabled. Unlike `startCheckout`, whose route is simply not registered,
   * `routes/users.ts` keeps this route registered and answers 503 — the same
   * choice `POST /users/me/payout` already makes on this router.
   */
  startUserSubscription: StartUserSubscription | undefined;
  getPublicCommunity: GetPublicCommunity;
  /**
   * `POST /c/:slug/checkout`. `undefined` EXACTLY when `payments` is `null` —
   * this use-case's constructor requires a real `PaymentProviderPort`, so
   * there is nothing to construct it against when payments are disabled (see
   * `selectPaymentProvider`). `routes/public-community.ts` does NOT register
   * the checkout route at all in that case (mirrors `scheduleLiveSession`'s
   * own undefined-ness, not `listLiveSessions`'s), so the route 404s through
   * the ordinary not-found path rather than answering with a 503 from a route
   * that does exist.
   */
  startCheckout: StartCheckout | undefined;
  /**
   * `POST /c/:slug/join-request`. Constructed unconditionally, unlike
   * `startCheckout` — whether a community accepts a free join is decided by
   * its own `accessMode`, never by this deployment's payment configuration.
   * See `RequestToJoin`'s own docstring for the 404 that keeps a `paid`
   * community from ever falling back to this path.
   */
  requestToJoin: RequestToJoin;
  /** `GET /c/:slug/request/:joinRequestId`. See `GetJoinRequestStatus`'s own docstring. */
  getJoinRequestStatus: GetJoinRequestStatus;
  /**
   * Task 4's `GET /communities/:communityId/join-requests` — the owner's
   * pending-requests dashboard list.
   */
  listJoinRequests: ListJoinRequests;
  /**
   * Task 4's `POST /communities/:communityId/join-requests/:requestId/approve`
   * and `.../reject`. ONE use case for both decisions — see its own docstring
   * for why splitting it into two would let the ownership check, the
   * already-decided check and the `activity_log` write drift apart.
   */
  decideJoinRequest: DecideJoinRequest;
  getSubscriptionStatus: GetSubscriptionStatus;
  handlePaymentWebhook: HandlePaymentWebhook;
  /**
   * Phase 6's creator dashboard reads. All three go through
   * `AnalyticsRepositoryPort`, whose every method is creator-scoped and which has
   * no unscoped variant — see the port for why that absence is the protection.
   */
  getCommunityMetrics: GetCommunityMetrics;
  getCommunityActivity: GetCommunityActivity;
  listCommunityMembers: ListCommunityMembers;
  /**
   * The roster as a downloadable CSV. It STREAMS — see the use-case for why one
   * unbounded select would put twice a successful creator's roster in memory per
   * concurrent download — and it carries members' WhatsApp numbers, so it is
   * authenticated like everything else and never logged.
   */
  exportCommunityMembers: ExportCommunityMembers;
  /**
   * The creator's manual "remove this member" action. It lives in the API rather
   * than the worker because revocation is SYNCHRONOUS: a creator removing someone
   * expects to be told whether it worked (see the use-case docstring). That is
   * also why the API selects messaging providers at all — the grant path never
   * calls one from this process.
   */
  revokeChannelAccess: RevokeChannelAccess;
  /**
   * Attaches a joining member's Telegram user id to the membership whose
   * single-use invite link they used. It lives in the API rather than the worker
   * because it is driven by an INBOUND webhook — see routes/webhooks.ts for why a
   * webhook rather than a `getUpdates` poll.
   *
   * Without it `channel_membership.external_member_id` is NULL forever and
   * `RevokeChannelAccess` can only report `no_provider_member_id_recorded`.
   */
  recordChannelJoin: RecordChannelJoin;
  /**
   * Phase 5's renewal reminder delivery.
   *
   * The DISPATCHER lives in the worker — `bootstrapWorker` registers it against the
   * `send_renewal_reminder` outbox event type, and this process claims no outbox rows.
   * It is constructed here anyway, and exposed, for the reason `messaging` and
   * `payments` are: so a test can prove what THIS process wired. Specifically that the
   * reminder's checkout link is built from the same resolved `appBaseUrl` this root
   * hands `StartCheckout` for `success_redirect_url` — the two must never disagree
   * about which deployment a member is sent to, and the only way to check that is to
   * be able to see both from one place.
   *
   * Phase 4's lesson, restated: a guard that exists in the API and has never crossed
   * the workspace seam is not a guard. Both roots build this use-case, and both are
   * tested.
   */
  sendRenewalReminder: SendRenewalReminder;
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
   * The static secret Telegram sends as `X-Telegram-Bot-Api-Secret-Token`, the
   * ONLY thing authenticating `POST /webhooks/telegram`. `undefined` when the box
   * is not configured for it (never outside the NODE_ENV allowlist —
   * `resolveTelegramWebhookSecret` throws there), in which case
   * `verifyCallbackToken` rejects every delivery rather than accepting any. Not
   * narrowed to `string` for the same reason as `xenditCallbackToken`.
   */
  telegramWebhookSecret: string | undefined;
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
   * here rather than kept private inside `StartCheckout` so a test can prove the
   * environment variable actually reaches the composition root: the confirmation
   * page was unreachable for an entire phase because nothing checked the wiring.
   */
  appBaseUrl: string;
  sql: DatabasePing;
  /**
   * The AI co-builder's provider adapter (Phase 7), `undefined` when the
   * feature is disabled — see `selectAiProvider`. Exposed for the same
   * reason `payments` and `messaging` are: a test must be able to prove what
   * THIS process actually wired (e.g. drive `FakeAiAdapter.nextBehaviour`
   * directly against a route test built on `bootstrap()`), and reading it
   * off a fake constructed by the test instead would prove only that the
   * test can call the fake.
   */
  aiProvider: AiProviderPort | undefined;
  /**
   * `undefined` EXACTLY when `aiProvider` is `undefined`. This is the ONE
   * signal `GET /ai/status` (routes/ai.ts) surfaces to the dashboard so it
   * can hide the chat screen instead of linking to one that always 503s —
   * see `selectAiProvider` for when that happens: a NODE_ENV outside
   * `RELAXED_NODE_ENVS` with no `OPENROUTER_API_KEY`/`OPENROUTER_MODEL`
   * configured. Unlike every other feature in this codebase, this is NOT a
   * reason to refuse to boot (design spec §11): the product works fine
   * without a co-builder.
   */
  sendAiMessage: SendAiMessage | undefined;
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
   * Task 3's `POST /communities/:communityId/events` — scheduling a live
   * session. `undefined` EXACTLY when `streamingProvider` is: this use-case
   * requires a real `StreamingProviderPort` (see `ScheduleLiveSession`'s own
   * docstring for why the "is streaming configured" decision is made once,
   * here, rather than inside the use-case), so there is nothing to construct
   * it against when streaming is disabled. `routes/events.ts` checks this
   * exactly the way `routes/ai.ts` checks `sendAiMessage` and answers 503.
   */
  scheduleLiveSession: ScheduleLiveSession | undefined;
  /**
   * Task 3's `GET /communities/:communityId/events`. Unlike
   * `scheduleLiveSession`, this FIELD is NEVER `undefined` — listing always
   * works whether streaming is configured on this box or not. The
   * `StreamingProviderPort` it is constructed with (below) MAY be
   * `undefined` though (Task 2 review, Important #3): it is passed through
   * as an OPTIONAL constructor param so `ListLiveSessions` can rebuild each
   * row's `rtmpUrl`/`whipUrl` from its persisted `streamKey` when a provider
   * is available, and return them `null` — never omit them, never throw —
   * when it is not. See `ListLiveSessions`'s own docstring for the full
   * reasoning.
   */
  listLiveSessions: ListLiveSessions;
  /**
   * Task 4's `POST /webhooks/mediamtx/auth` decision logic — `undefined`
   * EXACTLY when `streamTokenSecret` is. Mirrors `scheduleLiveSession`'s
   * undefined-ness rather than `listLiveSessions`'s: unlike listing,
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
   * `undefined`. Concretely: a relaxed dev box has "schedule a session"
   * enabled (`scheduleLiveSession` is set) while every call to
   * `POST /webhooks/mediamtx/auth` 401s (see `mediamtxWebhookSecret`
   * below) — a real, if confusing-looking, combination, and the correct
   * one: fail-closed on authorisation is the right default even when
   * scheduling itself is happily faked. Do not "fix" the route's
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
   * `xenditCallbackToken`/`telegramWebhookSecret` above. `undefined` in
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
   * Task 5's `POST /webhooks/mediamtx/lifecycle` decision logic — `undefined`
   * in lockstep with `mediamtxWebhookSecret` (both are read off the same
   * `MEDIAMTX_WEBHOOK_SECRET`; see that field for what "in lockstep" does and
   * does not imply). Unlike `authoriseStream`, this class needs no secret of
   * its own to do its job — it only reads and writes `event`, `activity_log`
   * and `outbox` — so gating its construction on the secret is a choice made
   * for symmetry with the route it serves (there is no reachable path to
   * `POST /lifecycle` on a box where the secret is unset, so wiring the
   * use-case anyway would only be dead weight) rather than a requirement of
   * the class itself.
   */
  handleStreamLifecycle: HandleStreamLifecycle | undefined;
  /**
   * Task 8's `GET /c/watch/:token` decision logic — `undefined` in lockstep
   * with `authoriseStream` (both are read off `STREAM_TOKEN_SECRET`; see
   * that field for what "in lockstep" does and does not imply). A member
   * opening a `/watch/<token>` URL on a box with streaming disabled sees the
   * SAME "link is not valid" message as an expired token — see
   * `routes/public-subscription.ts`'s `WATCH_REFUSED_BODY`.
   */
  resolveWatchToken: ResolveWatchToken | undefined;
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
 * An ALLOWLIST, deliberately — this is the same shape as `VISIBLE_STATUSES` in
 * get-public-community.ts, for the same reason: an unanticipated value must fail
 * CLOSED. The denylist this replaced (`if (nodeEnv === "production") throw`)
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
 * like it did. Worse, `CreatePaymentAccount` writes its `fake-acct-*` id into
 * `creator.xendit_account_id` and then 409s forever, so a creator onboarded on
 * a misconfigured production box can never connect a real Xendit sub-account
 * without manual SQL. A `console.log` is not a safety mechanism — these two
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
 *   - The fake adapter writes unrecoverable `fake-acct-*` ids into
 *     `creator.xendit_account_id`, so falling back to it here (`?? new
 *     FakePaymentAdapter()`, or any other stand-in that answers real calls)
 *     would ship exactly the disaster the original throw existed to prevent
 *     — a box that LOOKS like it takes payments and only takes fake ones.
 *   - `null` is genuinely absent instead: `bootstrap()` does not construct
 *     `StartCheckout` when this returns `null`, and `POST /c/:slug/checkout`
 *     is never registered, so it 404s through the ordinary not-found path.
 *     There is nothing left in the process for a caller to reach that would
 *     pretend to take a payment.
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
 * The messaging providers a process needs to turn a payment into access.
 *
 * Two fields rather than one map, because notifying and gating are different
 * capabilities and conflating them is a real bug: `TelegramBotAdapter.notify`
 * THROWS (it addresses a WhatsApp number it cannot reach), so a member who paid
 * would never be told anything.
 */
export interface MessagingProviders {
  /**
   * Gating providers keyed by `channel.platform`.
   *
   * WhatsApp is in here too, even though it cannot gate: a `whatsapp` channel must
   * resolve to a provider that reports `canGateAccess: false` — which
   * `GrantChannelAccess` turns into "a human will add you", recorded in
   * `activity_log` — rather than to nothing, which it treats as an unwired
   * platform and an error.
   */
  gating: ReadonlyMap<string, MessagingProviderPort>;
  /** How the MEMBER is reached. WhatsApp, always. */
  notifier: MessagingProviderPort;
}

/**
 * Chooses the messaging adapters, refusing to start rather than pretending to
 * invite anyone.
 *
 * Deliberately the same shape, thresholds and reasoning as
 * `selectPaymentProvider` above:
 *
 *   1. Both tokens set -> the real adapters, in every environment.
 *   2. PARTIAL configuration throws EVERYWHERE. A Telegram token with no Fonnte
 *      token mints a single-use invite link and has no way to deliver it: the
 *      member pays, a credential is created, and nobody is told. A Fonnte token
 *      with no Telegram token notifies members that they have access to a group
 *      nothing ever added them to.
 *   3. ABSENT configuration selects `FakeMessagingAdapter` ONLY when `NODE_ENV`
 *      is in `RELAXED_NODE_ENVS` — so `undefined`, `"staging"`, `"prod"` and
 *      `"production"` all throw. The fake records sends into an array instead of
 *      making them, so a box running it looks exactly like a working one from the
 *      outside while every paying member waits for a message that will never
 *      arrive. That is this phase's worst failure mode (plan, Global
 *      Constraints), and it is worth refusing to boot over.
 *
 * Both tokens are bearer credentials — the Telegram one is part of every Bot API
 * request PATH — so the startup line names the adapters and never the values.
 */
export function selectMessagingProviders(env: {
  telegramBotToken: string | undefined;
  fonnteApiToken: string | undefined;
  nodeEnv: string | undefined;
}): MessagingProviders {
  const telegramBotToken = presentOrUndefined(env.telegramBotToken);
  const fonnteApiToken = presentOrUndefined(env.fonnteApiToken);

  if (telegramBotToken && fonnteApiToken) {
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] messaging providers: TelegramBotAdapter (gating) + FonnteWhatsAppAdapter " +
        "(notification) — TELEGRAM_BOT_TOKEN and FONNTE_API_TOKEN are set, so real invites " +
        "will be issued and real messages sent"
    );
    const notifier = new FonnteWhatsAppAdapter({ apiToken: fonnteApiToken });
    return {
      gating: new Map<string, MessagingProviderPort>([
        ["telegram", new TelegramBotAdapter({ botToken: telegramBotToken })],
        ["whatsapp", notifier],
      ]),
      notifier,
    };
  }

  if (telegramBotToken || fonnteApiToken) {
    const missing = telegramBotToken ? "FONNTE_API_TOKEN" : "TELEGRAM_BOT_TOKEN";
    const present = telegramBotToken ? "TELEGRAM_BOT_TOKEN" : "FONNTE_API_TOKEN";
    throw new Error(
      `Messaging is half-configured: ${present} is set but ${missing} is not. Set both or ` +
        "neither — see apps/api/.env.example. Refusing to start rather than issuing invite " +
        "links nobody can be told about, or telling members about access nobody granted."
    );
  }

  if (!isRelaxedNodeEnv(env.nodeEnv)) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN and FONNTE_API_TOKEN are not set, and NODE_ENV is " +
        `${describeNodeEnv(env.nodeEnv)}. FakeMessagingAdapter is permitted ONLY when ` +
        `NODE_ENV is exactly ${RELAXED_NODE_ENVS_LIST}: it appends sends to an array, so a ` +
        "box running it looks like it is inviting paying members while nobody receives " +
        "anything. Add the tokens to apps/api/.env — see .env.example — or set " +
        "NODE_ENV=development."
    );
  }

  logProviderChoice(
    env.nodeEnv,
    "[bootstrap] messaging providers: FakeMessagingAdapter for both gating and notification " +
      "(TELEGRAM_BOT_TOKEN/FONNTE_API_TOKEN not set — no invite is issued and no message is " +
      "sent; set both to switch to the real adapters)"
  );
  const fakeNotifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
  return {
    gating: new Map<string, MessagingProviderPort>([
      ["telegram", new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true })],
      ["whatsapp", fakeNotifier],
    ]),
    notifier: fakeNotifier,
  };
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
 * Resolves `AI_FAKE_BEHAVIOUR`, the switch that makes `FakeAiAdapter`'s
 * hostile-payload behaviours reachable from OUTSIDE the API process.
 *
 * Before this, `FakeAiAdapter.nextBehaviour` could only be set by a test
 * holding a reference to the adapter instance bootstrap() constructed — so a
 * creator driving the co-builder chat screen in a real browser could only
 * ever see `"draft"` (the fake's hardcoded default), and the 502 ("prose"/
 * "truncated-json"), 503 ("timeout"), and any non-draft-happy-path response
 * were unreachable from the UI in every environment, including local dev
 * with no OpenRouter key. Task 8's gate found that gap and it is now closed:
 * an operator restarts the API with this set to drive any behaviour the
 * fake supports.
 *
 * Fails CLOSED on an unrecognised value, same rule as
 * `resolveAiDailyMessageLimit` and every other env parser in this file: a
 * typo'd behaviour name silently falling back to `"draft"` would look like
 * "it works" while testing nothing the operator intended to test.
 *
 * Deliberately NOT itself gated on `RELAXED_NODE_ENVS` — `selectAiProvider`
 * only ever calls this from inside the branch that is already behind that
 * allowlist (a `FakeAiAdapter` is never constructed outside it), so a second
 * check here would be dead code, not a second layer of safety. This
 * function has no effect at all in production: `OPENROUTER_API_KEY`/
 * `OPENROUTER_MODEL` set there selects `OpenRouterAiAdapter`, which has no
 * `nextBehaviour` to set, and unset selects `undefined` (the feature
 * disabled) — a `FakeAiAdapter` never exists for this value to reach.
 */
export function resolveAiFakeBehaviour(env: {
  value: string | undefined;
}): FakeAiBehaviour | undefined {
  const raw = presentOrUndefined(env.value);
  if (raw === undefined) {
    return undefined;
  }

  if (!(FAKE_AI_BEHAVIOURS as readonly string[]).includes(raw)) {
    throw new Error(
      `AI_FAKE_BEHAVIOUR must be one of ${FAKE_AI_BEHAVIOURS.join(", ")} (got "${raw}"). ` +
        "Unset it to keep the fake's default, draft."
    );
  }
  return raw as FakeAiBehaviour;
}

/**
 * Chooses the AI co-builder's provider adapter (Phase 7) — the ONE selector
 * in this file that does NOT refuse to boot when configuration is absent.
 * Unlike payments and messaging, nothing is on the line if the co-builder is
 * unavailable: no money moves and no invite is issued through this path
 * (design spec §11, plan Global Constraints) — the AI never writes to the
 * database beyond its own conversation transcript and usage counter.
 *
 *   1. Both `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` set -> the real
 *      adapter, in every environment.
 *   2. PARTIAL configuration throws in EVERY environment — same reasoning as
 *      `selectPaymentProvider`/`selectMessagingProviders`: a key with no
 *      model id (or vice versa) is a typo, never intentional.
 *   3. ABSENT configuration selects `FakeAiAdapter` ONLY inside
 *      `RELAXED_NODE_ENVS` (development/test) — the SAME allowlist reused
 *      from `isRelaxedNodeEnv`, not a second gate. `AI_FAKE_BEHAVIOUR` (see
 *      `resolveAiFakeBehaviour`) sets that instance's `nextBehaviour` so the
 *      fake's hostile-payload paths are reachable from a real browser, not
 *      only from a test holding the instance directly.
 *   4. ABSENT configuration OUTSIDE the allowlist returns `undefined` RATHER
 *      THAN THROWING: this is the one deliberate divergence from every other
 *      selector in this file. The feature is disabled, not the boot.
 *      `Dependencies.sendAiMessage` becomes `undefined` too, and
 *      `GET /ai/status` (routes/ai.ts) reports `enabled: false` so the
 *      dashboard hides the chat screen rather than linking to one that
 *      always 503s (plan Task 7).
 */
export function selectAiProvider(env: {
  apiKey: string | undefined;
  model: string | undefined;
  nodeEnv: string | undefined;
  fakeBehaviour?: string | undefined;
}): AiProviderPort | undefined {
  const apiKey = presentOrUndefined(env.apiKey);
  const model = presentOrUndefined(env.model);

  if (apiKey && model) {
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] AI provider: OpenRouterAiAdapter " +
        "(OPENROUTER_API_KEY and OPENROUTER_MODEL are set)"
    );
    return new OpenRouterAiAdapter({ apiKey, model });
  }

  if (apiKey || model) {
    const missing = apiKey ? "OPENROUTER_MODEL" : "OPENROUTER_API_KEY";
    const present = apiKey ? "OPENROUTER_API_KEY" : "OPENROUTER_MODEL";
    throw new Error(
      `AI co-builder is half-configured: ${present} is set but ${missing} is not. ` +
        "Set both or neither — see apps/api/.env.example. Refusing to start rather " +
        "than booting the fake AI adapter while looking configured."
    );
  }

  if (isRelaxedNodeEnv(env.nodeEnv)) {
    // Resolved BEFORE the fake is constructed: an invalid AI_FAKE_BEHAVIOUR
    // must throw with nothing left half-built, not discard an already-built
    // instance. The adapter's own constructor has no side effects, so this
    // reordering is cosmetic today — but it is the right shape to keep, not
    // the one to have to notice later.
    const behaviour = resolveAiFakeBehaviour({ value: env.fakeBehaviour });
    const fake = new FakeAiAdapter();
    if (behaviour !== undefined) {
      fake.nextBehaviour = behaviour;
    }
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] AI provider: FakeAiAdapter " +
        "(OPENROUTER_API_KEY/OPENROUTER_MODEL not set — no real model will be called; " +
        "set both to switch to OpenRouterAiAdapter)" +
        (behaviour !== undefined
          ? ` — AI_FAKE_BEHAVIOUR=${behaviour}, so every turn from here on gets that ` +
            "response rather than the fake's default draft"
          : "")
    );
    return fake;
  }

  logProviderChoice(
    env.nodeEnv,
    "[bootstrap] AI provider: none — the AI co-builder is DISABLED " +
      "(OPENROUTER_API_KEY/OPENROUTER_MODEL not set, and NODE_ENV is " +
      `${describeNodeEnv(env.nodeEnv)}, outside ${RELAXED_NODE_ENVS_LIST}). Unlike ` +
      "payments/messaging this does NOT block boot: GET /ai/status reports " +
      "enabled: false and POST /ai/messages returns 503. Set both env vars to enable it."
  );
  return undefined;
}

/**
 * The per-creator daily message cap `SendAiMessage` enforces through
 * `AiUsageRepositoryPort.consumeOne` — the only thing standing between a
 * creator (or a bug, or a stolen session) and an unbounded bill once a real
 * key is configured (see `ai-usage-repository.port.ts`). 50 is a judgement
 * call, not a mirrored value from anywhere else: generous enough that a
 * real onboarding conversation (a dozen or so turns) never gets cut off
 * mid-conversation, tight enough that a runaway loop cannot run up a
 * meaningful bill in one day.
 */
export const DEFAULT_AI_DAILY_MESSAGE_LIMIT = 50;

/**
 * Parses `AI_DAILY_MESSAGE_LIMIT`, failing closed on anything that is not a
 * positive whole number — the same rule `WORKER_POLL_INTERVAL_MS` follows in
 * `apps/worker`, for the same reason: `Number("abc")` is `NaN`, and a cap
 * that silently became `NaN` would make every `message_count < NaN`
 * comparison false, which is "allow nothing" rather than "no cap", the
 * opposite of what an operator fat-fingering this value would expect.
 */
export function resolveAiDailyMessageLimit(env: { value: string | undefined }): number {
  const raw = presentOrUndefined(env.value);
  if (raw === undefined) {
    return DEFAULT_AI_DAILY_MESSAGE_LIMIT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `AI_DAILY_MESSAGE_LIMIT must be a positive whole number (got "${raw}"). Unset it to ` +
        `use the default of ${DEFAULT_AI_DAILY_MESSAGE_LIMIT}.`
    );
  }
  return parsed;
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
 * floor as `JWT_SECRET`/`XENDIT_CALLBACK_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`
 * above and for the same reason: `MEDIAMTX_WEBHOOK_SECRET` is the ONLY
 * authentication on both MediaMTX webhooks (Task 4), and
 * `STREAM_TOKEN_SECRET` signs every watch token
 * (`apps/api/src/domain/watch-token.ts`) — a short one is
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
 * The secret `resolveTelegramWebhookSecret` hands back under `NODE_ENV=test`, and
 * the one value it refuses to accept anywhere else — same rule, and the same
 * reason, as `TEST_CALLBACK_TOKEN` above: it is committed to this repository, so
 * treating it as real would ship a publicly known webhook password.
 */
export const TEST_TELEGRAM_WEBHOOK_SECRET = "test-telegram-webhook-secret";

/**
 * Minimum `TELEGRAM_WEBHOOK_SECRET` length, mirroring `MIN_CALLBACK_TOKEN_LENGTH`
 * and `MIN_JWT_SECRET_LENGTH` on purpose. This secret is the ONLY authentication
 * on `POST /webhooks/telegram`, and forging a `chat_member` update means writing
 * an attacker-chosen `external_member_id` onto a membership — which is the id
 * `banChatMember` is aimed at, so it would turn a revocation into "remove somebody
 * else from the creator's group".
 */
const MIN_TELEGRAM_WEBHOOK_SECRET_LENGTH = 32;

/**
 * Characters Telegram's `setWebhook` accepts in `secret_token`: 1–256 of
 * `A-Z a-z 0-9 _ -`. Checked here so a secret with a space or a `+` in it fails at
 * BOOT with an explanation, rather than as an opaque 400 from `setWebhook` on a
 * box where the endpoint then rejects every real delivery.
 */
const TELEGRAM_WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Resolves the static secret that is the ONLY authentication on
 * `POST /webhooks/telegram`, delivered in the `X-Telegram-Bot-Api-Secret-Token`
 * header that `setWebhook`'s `secret_token` parameter installs.
 *
 * Deliberately the same four cases, thresholds and wording as
 * `resolveCallbackToken` above, because it is the same kind of thing: a STATIC
 * token that authenticates the sender and not the message.
 *
 *   1. A configured secret is used as-is (empty and whitespace-only count as
 *      unset), subject to the length floor and Telegram's charset.
 *   2. PARTIAL configuration throws in EVERY environment. A box with
 *      `TELEGRAM_BOT_TOKEN` set is gating real Telegram groups; without this
 *      secret the join endpoint rejects every delivery, so no
 *      `external_member_id` is ever recorded and revocation can never be
 *      automated — the exact gap this feature exists to close.
 *   3. ABSENT configuration returns `undefined` when `NODE_ENV` is one of
 *      `RELAXED_NODE_ENVS`, and throws for EVERYTHING else — `undefined`,
 *      `"staging"`, `"prod"`, `"PRODUCTION"`. A developer must be able to
 *      `bun run dev` without a public URL to point Telegram at.
 *   4. The committed test value is refused outside `NODE_ENV=test`.
 *
 * `undefined` fails CLOSED: `verifyCallbackToken` refuses an unset `expected`
 * before any comparison, so an unconfigured box rejects every update rather than
 * accepting every forged one.
 */
export function resolveTelegramWebhookSecret(env: {
  webhookSecret: string | undefined;
  telegramBotToken: string | undefined;
  nodeEnv: string | undefined;
}): string | undefined {
  const secret = presentOrUndefined(env.webhookSecret);

  if (secret !== undefined) {
    if (secret === TEST_TELEGRAM_WEBHOOK_SECRET) {
      if (env.nodeEnv !== "test") {
        throw new Error(
          "TELEGRAM_WEBHOOK_SECRET is the value committed to this repository for tests. " +
            "Anyone can read it, so it would authenticate a forged chat_member update — and " +
            "that update writes the very user id banChatMember is aimed at. Generate a real " +
            "one: openssl rand -hex 32"
        );
      }
      // Exempt from the length floor: it is the suite's own known value, and it is
      // already refused everywhere else by the branch above.
      return secret;
    }
    if (secret.length < MIN_TELEGRAM_WEBHOOK_SECRET_LENGTH) {
      throw new Error(
        `TELEGRAM_WEBHOOK_SECRET is too short (${secret.length} characters; ` +
          `${MIN_TELEGRAM_WEBHOOK_SECRET_LENGTH} required). It is the ONLY authentication on ` +
          "POST /webhooks/telegram, and a forged update writes an attacker-chosen member id " +
          "onto a membership. Generate one: openssl rand -hex 32"
      );
    }
    if (!TELEGRAM_WEBHOOK_SECRET_PATTERN.test(secret)) {
      throw new Error(
        "TELEGRAM_WEBHOOK_SECRET contains characters Telegram's setWebhook will not accept " +
          "(only A-Z, a-z, 0-9, _ and - are allowed, 1-256 of them). Refusing to start " +
          "rather than serving an endpoint whose secret can never be installed. Generate " +
          "one: openssl rand -hex 32"
      );
    }
    return secret;
  }

  // Before the production rule, so the suite — which never sets the variable —
  // keeps working even when a test hands this a configured bot token.
  if (env.nodeEnv === "test") {
    return TEST_TELEGRAM_WEBHOOK_SECRET;
  }

  if (presentOrUndefined(env.telegramBotToken)) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is set but TELEGRAM_WEBHOOK_SECRET is not. Real invite links " +
        "would be issued and no chat_member update could be authenticated, so no member's " +
        "Telegram user id would ever be recorded — and RevokeChannelAccess needs one, so " +
        "the creator could never remove anybody. Set both — see apps/api/.env.example."
    );
  }

  if (!isRelaxedNodeEnv(env.nodeEnv)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET is not set, and NODE_ENV is " +
        `${describeNodeEnv(env.nodeEnv)}. Booting without it is permitted ONLY when ` +
        `NODE_ENV is exactly ${RELAXED_NODE_ENVS_LIST}. Add it to apps/api/.env — see ` +
        ".env.example — or set NODE_ENV=development. Refusing to start rather than serving " +
        "a webhook endpoint that rejects every real delivery."
    );
  }

  logProviderChoice(
    env.nodeEnv,
    "[bootstrap] TELEGRAM_WEBHOOK_SECRET not set — POST /webhooks/telegram will reject " +
      "every delivery, so no member's Telegram user id will be recorded and revocation " +
      "cannot be automated. Set it (and setWebhook's secret_token to match) to exercise it."
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

  const creatorRepository = new DrizzleCreatorRepository(db);
  const passwordHasher = new BunPasswordHasher();
  const tokenIssuer = new HonoJwtTokenIssuer(jwtSecret);
  const registerCreator = new RegisterCreator(creatorRepository, passwordHasher, tokenIssuer);
  const authenticateCreator = new AuthenticateCreator(
    creatorRepository,
    passwordHasher,
    tokenIssuer
  );

  // Phase 9's personal accounts. `userTokenIssuer` deliberately reuses the
  // SAME `jwtSecret` as the creator `tokenIssuer` above — see
  // `HonoJwtUserTokenIssuer`'s own docstring for why the `typ` claim is what
  // keeps the two session kinds apart, not a second secret.
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
  // Task 5 of memberships-5a: `userTierRepository` (constructed above, Task 1)
  // is now GetUserProfile's third dependency too — the public profile's
  // `membership.tiers` read. Task 10 adds the fourth, `isMemberOf`, for the
  // same payload's `viewerIsMember`.
  const getUserProfile = new GetUserProfile(
    userRepository,
    followRepository,
    userTierRepository,
    isMemberOf
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
  const createPost = new CreatePost(postRepository, mediaRepository);
  const editPost = new EditPost(postRepository, mediaRepository);
  const deletePost = new DeletePost(postRepository);
  const listFeed = new ListFeed(postRepository, mediaRepository);
  const listUserPosts = new ListUserPosts(userRepository, postRepository, mediaRepository);

  const communityRepository = new DrizzleCommunityRepository(db);
  const listCommunities = new ListCommunities(communityRepository);
  const getCommunity = new GetCommunity(communityRepository);

  const tierRepository = new DrizzleMembershipTierRepository(db);
  const defineTier = new DefineMembershipTier(communityRepository, tierRepository);
  const listTiers = new ListTiers(communityRepository, tierRepository);
  const updateTier = new UpdateTier(communityRepository, tierRepository);

  const channelRepository = new DrizzleChannelRepository(db);
  const connectChannel = new ConnectChannel(communityRepository, channelRepository);
  const listChannels = new ListChannels(communityRepository, channelRepository);

  const payments: PaymentProviderPort | null = selectPaymentProvider({
    secretKey: process.env.XENDIT_SECRET_KEY,
    splitRuleId: process.env.XENDIT_SPLIT_RULE_ID,
    nodeEnv: process.env.NODE_ENV,
  });

  // Task 4. Resolved here rather than down with `messaging` below: nothing in
  // THIS task's `Dependencies` depends on it (Task 5's `RequestPasswordReset`
  // is the first consumer), so its position is not load-bearing the way
  // `payments`'s is for `createCommunity`/`updateCommunity` above.
  const email: EmailProviderPort | null = selectEmailProvider({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM,
    nodeEnv: process.env.NODE_ENV,
  });

  // `createCommunity`/`updateCommunity` are constructed here, after `payments`
  // is known, rather than up with `communityRepository` above: both need to
  // know whether this box has a payment provider at all, to refuse
  // `accessMode: "paid"` — see CreateCommunity/UpdateCommunity's own
  // docstrings — while `payments` itself has to be resolved here anyway
  // (see the `xenditCallbackToken` comment below for why THIS position is
  // fixed).
  const createCommunity = new CreateCommunity(communityRepository, {
    paymentsEnabled: payments !== null,
  });
  const updateCommunity = new UpdateCommunity(communityRepository, {
    paymentsEnabled: payments !== null,
  });
  // `undefined` EXACTLY when `payments` is `null` — see `createPaymentAccount`'s
  // own field docstring on `Dependencies`.
  const createPaymentAccount = payments
    ? new CreatePaymentAccount(creatorRepository, payments)
    : undefined;
  const getPaymentAccountStatus = new GetPaymentAccountStatus(creatorRepository);
  // Phase 5a's parallel flow for `app_user`. `undefined` on the same condition
  // `createPaymentAccount` is, and for the same reason; the STATUS reader below
  // is always constructed, because a box with payments disabled must still be
  // able to answer the question.
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
  // STILL TRUE: `createCommunity`/`updateCommunity`/`createPaymentAccount` above
  // all need `payments` already resolved, so this call has to happen no later
  // than it does regardless of anything below it.
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

  // `paymentsEnabled` for the same reason `createCommunity`/`updateCommunity`
  // take it, and it MUST be the same `payments !== null` they read: that is what
  // decides whether `POST /c/:slug/checkout` is registered, so it is also what
  // decides whether a `paid` community has any join path on this box. Without
  // it, such a community advertised a price and a buy button whose route 404s.
  const getPublicCommunity = new GetPublicCommunity(communityRepository, tierRepository, {
    paymentsEnabled: payments !== null,
  });

  const memberRepository = new DrizzleMemberRepository(db);
  const subscriptionRepository = new DrizzleSubscriptionRepository(db);
  // Task 3's event repository, constructed here (rather than down by
  // `scheduleLiveSession`/`listLiveSessions`, where it used to live alone)
  // because `getSubscriptionStatus` below needs it too — one shared instance,
  // same rule `subscriptionRepository` already follows for its own many
  // consumers.
  const eventRepository = new DrizzleEventRepository(db);
  const appBaseUrl = resolveAppBaseUrl({
    appBaseUrl: process.env.APP_BASE_URL,
    nodeEnv: process.env.NODE_ENV,
  });
  // `undefined` EXACTLY when `payments` is `null` — see this field's own
  // docstring on `Dependencies`. `routes/public-community.ts` does not
  // register `POST /c/:slug/checkout` at all when this is `undefined`, so a
  // request to it 404s through the ordinary not-found path.
  const startCheckout = payments
    ? new StartCheckout(
        communityRepository,
        tierRepository,
        memberRepository,
        subscriptionRepository,
        creatorRepository,
        payments,
        clock,
        { appBaseUrl }
      )
    : undefined;

  // Task 6 of Phase 5a. `undefined` on the same condition `startCheckout` above
  // is, and for the same reason — but the ROUTE stays registered and answers
  // 503, see this field's own docstring on `Dependencies`.
  const startUserSubscription = payments
    ? new StartUserSubscription(
        userRepository,
        userTierRepository,
        userPayoutRepository,
        userSubscriptionRepository,
        payments,
        // The SAME clock `isMemberOf` above reads, so the two cannot disagree
        // about whether a subscription's period has passed — the divergence
        // between them is precisely what the final review's I1 was about.
        clock,
        { appBaseUrl }
      )
    : undefined;

  // Task 3 (free communities): constructed UNCONDITIONALLY, unlike
  // `startCheckout` above — see `Dependencies.requestToJoin`'s own docstring
  // for why a community's `accessMode`, not this deployment's payment
  // configuration, is what decides whether a free join is accepted.
  const joinRequestRepository = new DrizzleJoinRequestRepository(db);
  const joinRequestUnitOfWork = new DrizzleJoinRequestUnitOfWork(db);
  const requestToJoin = new RequestToJoin(
    communityRepository,
    tierRepository,
    memberRepository,
    subscriptionRepository,
    joinRequestUnitOfWork
  );
  const getJoinRequestStatus = new GetJoinRequestStatus(
    communityRepository,
    joinRequestRepository,
    subscriptionRepository
  );
  // Task 4: the owner's decisions. `decideJoinRequest` shares
  // `joinRequestUnitOfWork` with `requestToJoin` above — same transaction
  // mechanism, different use of it — and reads `joinRequestRepository`/
  // `subscriptionRepository` off the pool for its pre-transaction checks
  // (ownership, the request lookup, the tier-active check, and the graceful
  // already-active pre-check), exactly like `requestToJoin` does.
  const listJoinRequests = new ListJoinRequests(communityRepository, joinRequestRepository);
  const decideJoinRequest = new DecideJoinRequest(
    communityRepository,
    tierRepository,
    joinRequestRepository,
    subscriptionRepository,
    joinRequestUnitOfWork
  );

  // Task 8's watch link. Read directly off `process.env` here (rather than
  // derived from `streamingProvider`'s truthiness) for the exact reason
  // `authoriseStream`/`mediamtxWebhookSecret` do this further down: by the
  // time `selectStreamingProvider` (below) has run without throwing, either
  // all five streaming vars are set and length-valid or all five are
  // genuinely absent — so a plain `presentOrUndefined` read here is exactly
  // as strict, without this file's several selectors needing to agree about
  // what "configured" means. Declared before `selectStreamingProvider` is
  // even called is safe: a half-configured box makes that call throw before
  // this function ever returns anything, so nothing constructed off this
  // value here is ever handed to a caller in that case.
  const streamTokenSecret = presentOrUndefined(process.env.STREAM_TOKEN_SECRET);
  const getSubscriptionStatus = new GetSubscriptionStatus(subscriptionRepository, eventRepository, {
    streamTokenSecret,
  });

  // The webhook's three writes commit together or not at all — see
  // PaymentActivationUnitOfWorkPort. The read that precedes them uses the
  // pooled repository directly.
  const paymentActivationUnitOfWork = new DrizzlePaymentActivationUnitOfWork(db);
  const handlePaymentWebhook = new HandlePaymentWebhook(
    subscriptionRepository,
    // Phase 5a's parallel flow. Xendit delivers ONE webhook stream, so the same
    // use case resolves both kinds of invoice — routed on the `external_id`
    // namespace, never guessed (see `domain/user-payment.ts`).
    userSubscriptionRepository,
    paymentActivationUnitOfWork,
    clock
  );

  // Phase 6's dashboard reads. One repository, three use-cases, every method
  // creator-scoped at the port.
  const analyticsRepository = new DrizzleAnalyticsRepository(db);
  const getCommunityMetrics = new GetCommunityMetrics(analyticsRepository);
  const getCommunityActivity = new GetCommunityActivity(analyticsRepository);
  const listCommunityMembers = new ListCommunityMembers(analyticsRepository);
  // Takes the COMMUNITY repository too, for the slug the download's filename needs
  // — and its `findByIdForCreator` is the ownership check, which has to happen
  // before a single roster row is read because a stream cannot be un-sent.
  const exportCommunityMembers = new ExportCommunityMembers(
    communityRepository,
    analyticsRepository
  );

  // Revocation used to be the ONE messaging call the API process made outside
  // signup/login (granting happens in apps/worker) — Task 5's password reset and
  // its existing-email signup notice are the second and third. Same allowlist as
  // the payment adapter either way: on a box with no tokens and a NODE_ENV
  // outside the allowlist this throws rather than booting a fake that would
  // report a send it never performed.
  const messaging = selectMessagingProviders({
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
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

  const channelMembershipRepository = new DrizzleChannelMembershipRepository(db);
  const revokeChannelAccess = new RevokeChannelAccess(
    communityRepository,
    channelMembershipRepository,
    new DrizzleActivityLogRepository(db),
    messaging.gating,
    // A removal the provider could not perform is enqueued here, and apps/worker
    // retries it — see OUTBOX_REVOKE_ACCESS. The POOLED client: this use-case is
    // synchronous and opens no transaction, so an outbox failure must not be able to
    // undo a revocation the creator has already been told about.
    new DrizzleOutboxRepository(db)
  );

  // The other half of revocation, and the half that was missing: without a
  // recorded platform member id, `revokeChannelAccess` above can only ever report
  // `no_provider_member_id_recorded`.
  const recordChannelJoin = new RecordChannelJoin(channelMembershipRepository);

  // Phase 5. Built with the SAME `appBaseUrl` StartCheckout received above, and with
  // `messaging.notifier` rather than a gating provider: `TelegramBotAdapter.notify`
  // throws. See the `sendRenewalReminder` field on `Dependencies` for why the API root
  // builds a use-case the worker dispatches.
  const sendRenewalReminder = new SendRenewalReminder(
    subscriptionRepository,
    memberRepository,
    new DrizzleActivityLogRepository(db),
    messaging.notifier,
    { appBaseUrl }
  );
  const telegramWebhookSecret = resolveTelegramWebhookSecret({
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    nodeEnv: process.env.NODE_ENV,
  });

  // Phase 7's AI co-builder. The ONE feature in this codebase that boots
  // disabled rather than refusing to start — see selectAiProvider.
  // `sendAiMessage` mirrors `aiProvider`'s undefined-ness exactly, which is
  // what `GET /ai/status` reports and what `POST /ai/messages` checks.
  const aiProvider = selectAiProvider({
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL,
    nodeEnv: process.env.NODE_ENV,
    fakeBehaviour: process.env.AI_FAKE_BEHAVIOUR,
  });
  // `resolveAiDailyMessageLimit` is called ONLY inside this branch, not
  // unconditionally above it — it throws on a malformed
  // `AI_DAILY_MESSAGE_LIMIT`, and that throw must never be reachable when
  // `aiProvider` is `undefined`. The co-builder disabled (no OpenRouter key)
  // plus a fat-fingered limit is exactly the box that must still boot: the
  // env var is irrelevant to a disabled feature, so it must not be read at
  // all in that case, matching `selectAiProvider`'s own "boots disabled
  // rather than refusing to start" rule.
  const sendAiMessage = aiProvider
    ? new SendAiMessage(
        new DrizzleAiConversationRepository(db),
        new DrizzleAiUsageRepository(db),
        aiProvider,
        clock,
        { dailyLimit: resolveAiDailyMessageLimit({ value: process.env.AI_DAILY_MESSAGE_LIMIT }) }
      )
    : undefined;

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

  // Task 3's scheduling endpoints. `eventRepository` is constructed earlier
  // now (Task 8 needs it for `getSubscriptionStatus` too) and shared, not
  // itself exposed on `Dependencies` — same rule the tier/channel
  // repositories follow, since nothing outside this module needs to see it.
  // `scheduleLiveSession` mirrors `sendAiMessage`'s undefined-ness exactly:
  // constructed only when `streamingProvider` is, because its constructor
  // requires a real `StreamingProviderPort` rather than accepting
  // `| undefined` and checking internally — see `ScheduleLiveSession`'s
  // docstring for why that decision belongs here and not there.
  const scheduleLiveSession = streamingProvider
    ? new ScheduleLiveSession(eventRepository, streamingProvider)
    : undefined;
  // `streamingProvider` (possibly `undefined`) passed through, NOT gated the
  // way `scheduleLiveSession` is above: `ListLiveSessions` takes it as an
  // OPTIONAL constructor param specifically so listing keeps working with
  // streaming disabled (see that class's own docstring, Task 2 review
  // Important #3) — it rebuilds rtmpUrl/whipUrl from each row's persisted
  // streamKey when a provider is available, and returns them `null`
  // otherwise, rather than needing a second undefined-ness story here.
  const listLiveSessions = new ListLiveSessions(eventRepository, streamingProvider);

  // Task 4's publish/read authorisation. The webhook secret is read directly
  // here rather than re-derived from `streamingProvider`'s truthiness, and
  // `streamTokenSecret` itself was already resolved earlier (alongside
  // `getSubscriptionStatus`) — see that declaration for why reading it before
  // `selectStreamingProvider` runs is still safe. Both secrets rely on the
  // SAME invariant `selectStreamingProvider` enforces: by the time execution
  // reaches this line, either both MEDIAMTX_WEBHOOK_SECRET and
  // STREAM_TOKEN_SECRET are set and length-valid (the five-vars-together
  // branch), or both are genuinely absent (partial configuration threw
  // already) — so a plain `presentOrUndefined` read is exactly as strict as
  // re-checking `streamingProvider`, without depending on this file's several
  // selectors agreeing forever about what "configured" means.
  const mediamtxWebhookSecret = presentOrUndefined(process.env.MEDIAMTX_WEBHOOK_SECRET);
  const authoriseStream = streamTokenSecret
    ? new AuthoriseStream(eventRepository, subscriptionRepository, { streamTokenSecret })
    : undefined;

  // Task 8's `GET /c/watch/:token`. `undefined` in lockstep with
  // `authoriseStream` — both need nothing but `STREAM_TOKEN_SECRET`, and
  // both refuse everything (this route's ONE generic body; that webhook's
  // `{ allowed: false }`) when it is absent.
  //
  // `hlsBaseUrl` (final whole-branch review fix — see `ResolveWatchToken`'s
  // own docstring): this class now BUILDS the member-facing HLS URL from
  // `event.id` rather than trusting the `streamKey`-shaped
  // `event.hlsPlaybackPath` column, so it needs the same public HLS origin
  // `MediaMtxAdapter` was configured with. Reading `MEDIAMTX_HLS_BASE_URL`
  // directly here, rather than threading it through from `streamingProvider`,
  // relies on the SAME invariant `mediamtxWebhookSecret` above already does:
  // `selectStreamingProvider` (already run, without throwing, by the time
  // this line executes) enforces all five streaming env vars together or
  // none at all, so `streamTokenSecret` present implies
  // `MEDIAMTX_HLS_BASE_URL` is too.
  const resolveWatchToken = streamTokenSecret
    ? new ResolveWatchToken(eventRepository, subscriptionRepository, {
        streamTokenSecret,
        hlsBaseUrl: presentOrUndefined(process.env.MEDIAMTX_HLS_BASE_URL) as string,
      })
    : undefined;

  // Task 5's `POST /webhooks/mediamtx/lifecycle`. Gated on `mediamtxWebhookSecret`
  // rather than constructed unconditionally — see the `handleStreamLifecycle`
  // field's own docstring for why that is a symmetry choice, not a real
  // dependency of the class. Takes BOTH the pooled `eventRepository` (the
  // stream-key lookup, kept outside any transaction — review round 2, mirroring
  // `HandlePaymentWebhook`'s own split) AND the unit-of-work (the transition, its
  // activity_log row, and every per-member notify_stream_live row, which must
  // commit or roll back together — see `StreamLifecycleUnitOfWorkPort`'s own
  // docstring for why).
  const handleStreamLifecycle = mediamtxWebhookSecret
    ? new HandleStreamLifecycle(eventRepository, new DrizzleStreamLifecycleUnitOfWork(db))
    : undefined;

  return {
    creatorRepository,
    tokenIssuer,
    payments,
    email,
    registerCreator,
    authenticateCreator,
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
    createPost,
    maxPostImages,
    editPost,
    deletePost,
    listFeed,
    listUserPosts,
    requestPasswordReset,
    completePasswordReset,
    createCommunity,
    listCommunities,
    updateCommunity,
    getCommunity,
    defineTier,
    listTiers,
    updateTier,
    connectChannel,
    listChannels,
    createPaymentAccount,
    getPaymentAccountStatus,
    connectUserPayout,
    getUserPayoutStatus,
    manageUserTiers,
    startUserSubscription,
    getPublicCommunity,
    startCheckout,
    requestToJoin,
    getJoinRequestStatus,
    listJoinRequests,
    decideJoinRequest,
    getSubscriptionStatus,
    handlePaymentWebhook,
    getCommunityMetrics,
    getCommunityActivity,
    listCommunityMembers,
    exportCommunityMembers,
    revokeChannelAccess,
    recordChannelJoin,
    sendRenewalReminder,
    messaging,
    telegramWebhookSecret,
    xenditCallbackToken,
    appBaseUrl,
    sql,
    aiProvider,
    sendAiMessage,
    streamingProvider,
    scheduleLiveSession,
    listLiveSessions,
    authoriseStream,
    resolveWatchToken,
    mediamtxWebhookSecret,
    handleStreamLifecycle,
    mediaStorage,
    uploadMedia,
    mediaRepository,
  };
}
