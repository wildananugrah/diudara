import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bootstrap,
  DEFAULT_APP_BASE_URL,
  DEFAULT_AI_DAILY_MESSAGE_LIMIT,
  RELAXED_NODE_ENVS,
  resolveAiDailyMessageLimit,
  resolveAiFakeBehaviour,
  resolveAppBaseUrl,
  resolveCallbackToken,
  resolveTelegramWebhookSecret,
  selectAiProvider,
  selectEmailProvider,
  selectMediaStorage,
  selectMessagingProviders,
  selectPaymentProvider,
  selectStreamingProvider,
  TEST_CALLBACK_TOKEN,
  TEST_TELEGRAM_WEBHOOK_SECRET,
  type Dependencies,
} from "./bootstrap";
import { FakeMediaStorageAdapter } from "./infrastructure/storage/fake-media-storage.adapter";
import { S3MediaStorageAdapter } from "./infrastructure/storage/s3-media-storage.adapter";
import { FakeMessagingAdapter } from "./infrastructure/messaging/fake-messaging.adapter";
import { FonnteWhatsAppAdapter } from "./infrastructure/messaging/fonnte-whatsapp.adapter";
import { TelegramBotAdapter } from "./infrastructure/messaging/telegram-bot.adapter";
import { FAKE_AI_BEHAVIOURS, FakeAiAdapter } from "./infrastructure/ai/fake-ai.adapter";
import { OpenRouterAiAdapter } from "./infrastructure/ai/openrouter-ai.adapter";
import { SendAiMessage } from "./application/use-cases/send-ai-message";
import { ListLiveSessions } from "./application/use-cases/schedule-live-session";
import { MediaMtxAdapter } from "./infrastructure/streaming/mediamtx.adapter";
import { FakeStreamingAdapter } from "./infrastructure/streaming/fake-streaming.adapter";
import { createApp } from "./app";
import { FakePaymentAdapter } from "./infrastructure/payments/fake-payment.adapter";
import { XenditPaymentAdapter } from "./infrastructure/payments/xendit-payment.adapter";
import { FakeEmailAdapter } from "./infrastructure/email/fake-email.adapter";
import { ResendEmailAdapter } from "./infrastructure/email/resend-email.adapter";
import { RegisterCreator } from "./application/use-cases/register-creator";
import { AuthenticateCreator } from "./application/use-cases/authenticate-creator";
import { RegisterUser } from "./application/use-cases/register-user";
import { AuthenticateUser } from "./application/use-cases/authenticate-user";
import { GetUserProfile } from "./application/use-cases/get-user-profile";
import { UpdateUserProfile } from "./application/use-cases/update-user-profile";
import { FollowUser, ListFollows } from "./application/use-cases/follow-user";
import { ExploreUsers } from "./application/use-cases/explore-users";
import { RequestPasswordReset } from "./application/use-cases/request-password-reset";
import { CompletePasswordReset } from "./application/use-cases/complete-password-reset";
import type { PasswordResetRepositoryPort } from "./application/ports/password-reset-repository.port";
import type {
  PasswordResetRepositories,
  PasswordResetUnitOfWorkPort,
} from "./application/ports/password-reset-unit-of-work.port";
import type { SignupNoticeRepositoryPort } from "./application/ports/signup-notice-repository.port";
import { CreateCommunity } from "./application/use-cases/create-community";
import { ListCommunities } from "./application/use-cases/list-communities";
import { UpdateCommunity } from "./application/use-cases/update-community";
import { GetCommunity } from "./application/use-cases/get-community";
import {
  DefineMembershipTier,
  ListTiers,
  UpdateTier,
} from "./application/use-cases/manage-tiers";
import { ConnectChannel, ListChannels } from "./application/use-cases/manage-channels";
import { CreatePaymentAccount } from "./application/use-cases/create-payment-account";
import { GetPaymentAccountStatus } from "./application/use-cases/get-payment-account-status";
import { GetPublicCommunity } from "./application/use-cases/get-public-community";
import { StartCheckout } from "./application/use-cases/start-checkout";
import { GetSubscriptionStatus } from "./application/use-cases/get-subscription-status";
import { GetJoinRequestStatus, RequestToJoin } from "./application/use-cases/request-to-join";
import { DecideJoinRequest, ListJoinRequests } from "./application/use-cases/decide-join-request";
import { HandlePaymentWebhook } from "./application/use-cases/handle-payment-webhook";
import { RevokeChannelAccess } from "./application/use-cases/revoke-channel-access";
import { RecordChannelJoin } from "./application/use-cases/record-channel-join";
import { SendRenewalReminder } from "./application/use-cases/send-renewal-reminder";
import { GetCommunityMetrics } from "./application/use-cases/get-community-metrics";
import { GetCommunityActivity } from "./application/use-cases/get-community-activity";
import { ListCommunityMembers } from "./application/use-cases/list-community-members";
import { ExportCommunityMembers } from "./application/use-cases/export-community-members";
import { XENDIT_ACCOUNT_PROVISIONING } from "./domain/payment-account";
import type {
  CreatorRecord,
  CreatorRepositoryPort,
} from "./application/ports/creator-repository.port";
import type { UserRepositoryPort } from "./application/ports/user-repository.port";
import type { FollowRepositoryPort } from "./application/ports/follow-repository.port";
import type { PostRepositoryPort } from "./application/ports/post-repository.port";
import { CreatePost, DeletePost, EditPost } from "./application/use-cases/write-post";
import type { MediaRepositoryPort } from "./application/ports/media-repository.port";
import { UploadMedia } from "./application/use-cases/upload-media";
import { ListFeed, ListUserPosts } from "./application/use-cases/read-posts";
import type { UserTokenIssuerPort } from "./application/ports/user-token-issuer.port";
import type { ClockPort } from "./application/ports/clock.port";
import type { CommunityRepositoryPort } from "./application/ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "./application/ports/membership-tier-repository.port";
import type { ChannelRepositoryPort } from "./application/ports/channel-repository.port";
import type { MemberRepositoryPort } from "./application/ports/member-repository.port";
import type { SubscriptionRepositoryPort } from "./application/ports/subscription-repository.port";
import type { WebhookEventRepositoryPort } from "./application/ports/webhook-event-repository.port";
import type { ActivityLogRepositoryPort } from "./application/ports/activity-log-repository.port";
import type { AnalyticsRepositoryPort } from "./application/ports/analytics-repository.port";
import type { ChannelMembershipRepositoryPort } from "./application/ports/channel-membership-repository.port";
import type { MessagingProviderPort } from "./application/ports/messaging-provider.port";
import type { OutboxRepositoryPort } from "./application/ports/outbox-repository.port";
import type { EventRepositoryPort } from "./application/ports/event-repository.port";
import type { PaymentActivationUnitOfWorkPort } from "./application/ports/payment-activation-unit-of-work.port";
import type { JoinRequestRepositoryPort } from "./application/ports/join-request-repository.port";
import type { JoinRequestUnitOfWorkPort } from "./application/ports/join-request-unit-of-work.port";
import type { PasswordHasherPort } from "./application/ports/password-hasher.port";
import type { TokenIssuerPort } from "./application/ports/token-issuer.port";
import type { PaymentProviderPort } from "./application/ports/payment-provider.port";

/**
 * Guards dependency inversion: `Dependencies` must be typed against PORTS, not
 * against the concrete adapters. If it ever infers a concrete class again (e.g.
 * `ReturnType<typeof bootstrap>`), the object literals below stop type-checking
 * and `bun run typecheck` fails. No `as` casts are allowed in this file — a cast
 * would hide exactly the regression this test exists to catch.
 *
 * `registerCreator`/`authenticateCreator`/`createCommunity`/`listCommunities`/
 * `updateCommunity`/`defineTier`/`listTiers`/`updateTier`/`connectChannel`/
 * `listChannels`/`createPaymentAccount`/`getPublicCommunity`/`startCheckout`/
 * `getSubscriptionStatus` are typed as the
 * concrete use-case classes (there's only one implementation of each, so no
 * port exists for them) — a class with private members can't be satisfied by
 * a plain object literal without a cast, so the fakes below construct real
 * instances of those classes wrapping hand-written fake ports instead.
 */
/**
 * Task 5's delivery routes need `mediaRepository` on `Dependencies` in
 * addition to `uploadMedia`. Neither test that builds a `Dependencies` by
 * hand below calls `mediaRepository.findById` or `uploadMedia.execute` — both
 * are here purely to satisfy the port's shape — so one shared fake, reused at
 * both call sites, is enough; unlike `fakeCreatorRepository` below it needs
 * no per-test state.
 */
const fakeMediaRepository: MediaRepositoryPort = {
  async create(): Promise<never> {
    throw new Error("not used");
  },
  async findById() {
    return null;
  },
  async findManyByIds() {
    return [];
  },
  async claim() {},
  async listForPost() {
    return [];
  },
  async listForPosts() {
    return [];
  },
  async listUnclaimedBefore() {
    return [];
  },
  async deleteById() {},
};

const fakeTokenIssuer: TokenIssuerPort = {
  async issue() {
    return "fake.token.value";
  },
  async verify() {
    return null;
  },
};

const fakePasswordHasher: PasswordHasherPort = {
  async hash(plain) {
    return `hashed:${plain}`;
  },
  async verify() {
    return false;
  },
};

const fakeUserTokenIssuer: UserTokenIssuerPort = {
  async issue() {
    return "fake.user.token.value";
  },
  async verify() {
    return null;
  },
};

const fakeUserRepository: UserRepositoryPort = {
  async create() {
    throw new Error("not used");
  },
  async findByHandle() {
    return null;
  },
  async findById() {
    return null;
  },
  async findByEmail() {
    return null;
  },
  async findCredentialsByEmail() {
    return null;
  },
  async updateProfile() {
    return null;
  },
  async setPasswordAndBumpEpoch() {
    return false;
  },
  async searchPublic() {
    return [];
  },
  async newestPublic() {
    return [];
  },
  async mostFollowedPublic() {
    return [];
  },
};

/** Task 2 (profiles and following)'s repository, faked the same shallow way every other repository above is — these tests are about `Dependencies` wiring, not follow behaviour. */
const fakeFollowRepository: FollowRepositoryPort = {
  async follow() {
    return true;
  },
  async unfollow() {
    return true;
  },
  async isFollowing() {
    return false;
  },
  async followedHandlesAmong() {
    return [];
  },
  async countsFor() {
    return { followers: 0, following: 0 };
  },
  async listFollowers() {
    return [];
  },
  async listFollowing() {
    return [];
  },
};

/** Task 2 of posts-and-feed's repository, faked the same shallow way `fakeFollowRepository` is above. */
const fakePostRepository: PostRepositoryPort = {
  async create(_authorId, body) {
    return {
      id: "fake-post",
      body,
      createdAt: new Date(0),
      editedAt: null,
      authorHandle: "fake",
      authorDisplayName: "Fake",
    };
  },
  async ownershipOf() {
    return null;
  },
  async updateBody() {
    return null;
  },
  async softDelete() {},
  async listGlobal() {
    return [];
  },
  async listFollowing() {
    return [];
  },
  async listByAuthor() {
    return [];
  },
};

const fakeCommunityRepository: CommunityRepositoryPort = {
  async create() {
    throw new Error("not used");
  },
  async findByIdForCreator() {
    return null;
  },
  async listByCreator() {
    return [];
  },
  async slugExists() {
    return false;
  },
  async update() {
    return null;
  },
  async findBySlug() {
    return null;
  },
};

const fakeMembershipTierRepository: MembershipTierRepositoryPort = {
  async create() {
    throw new Error("not used");
  },
  async listByCommunity() {
    return [];
  },
  async updateForCommunity() {
    return null;
  },
};

const fakeChannelRepository: ChannelRepositoryPort = {
  async create() {
    throw new Error("not used");
  },
  async listByCommunity() {
    return [];
  },
};

const fakeEventRepository: EventRepositoryPort = {
  async createForCreator() {
    throw new Error("not used");
  },
  async findByIdForCreator() {
    return null;
  },
  async listForCommunityForCreator() {
    return [];
  },
  async markLive() {
    return null;
  },
  async markEnded() {
    return null;
  },
  async findByStreamKey() {
    return null;
  },
  async findById() {
    return null;
  },
  async findLiveByCommunityId() {
    return null;
  },
};

const fakeMemberRepository: MemberRepositoryPort = {
  async findOrCreateByWhatsappNumber() {
    throw new Error("not used");
  },
  async findById() {
    return null;
  },
};

/**
 * Phase 5 gave `StartCheckout` and `HandlePaymentWebhook` a clock. A fixed one here, like
 * every other fake in this file: nothing in these tests depends on the instant, and a
 * `SystemClock` would make the composition-root fakes depend on the wall clock.
 */
const fakeClock: ClockPort = {
  now: () => new Date("2026-08-09T11:00:00.000Z"),
};

/**
 * Task 5's password-reset fakes. Nothing in the two "fully faked
 * Dependencies" tests below exercises password reset — they only need a
 * `Dependencies` object that TYPE-CHECKS — so these refuse every method
 * rather than backing a real in-memory store, the same "not used" shape
 * every other never-exercised fake in this file follows.
 */
const fakePasswordResetRepository: PasswordResetRepositoryPort = {
  async create() {
    throw new Error("not used");
  },
  async findByHash() {
    return null;
  },
  async countForUserSince() {
    return 0;
  },
  async countForIpSince() {
    return 0;
  },
  async markUsed() {
    return false;
  },
  async markAllOtherOutstandingUsed() {
    return 0;
  },
};

class FakePasswordResetUnitOfWork implements PasswordResetUnitOfWorkPort {
  async run<T>(work: (repositories: PasswordResetRepositories) => Promise<T>): Promise<T> {
    return work({ passwordResets: fakePasswordResetRepository, users: fakeUserRepository });
  }
}

/**
 * Review finding F3's rate-limit ledger — same "not used" shape as
 * `fakePasswordResetRepository` above: nothing in the two "fully faked
 * Dependencies" tests below signs up against an existing email, so this
 * only needs to type-check.
 */
const fakeSignupNoticeRepository: SignupNoticeRepositoryPort = {
  async countForUserSince() {
    return 0;
  },
  async record() {
    // no-op
  },
};

const fakeSubscriptionRepository: SubscriptionRepositoryPort = {
  async createPending() {
    throw new Error("not used");
  },
  async createActiveWithoutBilling() {
    throw new Error("not used");
  },
  async findCurrentSubscriptionForTier() {
    return null;
  },
  async createTransaction() {
    throw new Error("not used");
  },
  async findById() {
    throw new Error("not used");
  },
  async findByIdWithCommunity() {
    return null;
  },
  async findTransactionByExternalId() {
    return null;
  },
  async attachGatewayReference() {
    return true;
  },
  async findDueForRenewal() {
    // Phase 5's renewal pass runs in the worker, not behind an HTTP route.
    return [];
  },
  async markPastDue() {
    return false;
  },
  async findPastGraceDeadline() {
    // Phase 5's churn pass runs in the worker, not behind an HTTP route.
    return [];
  },
  async markChurned() {
    return false;
  },
  async findRenewalContext() {
    // Phase 5's reminder delivery runs in the worker, not behind an HTTP route.
    return null;
  },
  async hasLiveSubscriptionInCommunity() {
    // Read only by the churn revoke, which runs in the worker.
    return false;
  },
  async listActiveForCommunity() {
    // Read only by NotifyStreamLive, which runs in the worker.
    return [];
  },
  async markPaid() {
    throw new Error("not used");
  },
};

const fakeWebhookEventRepository: WebhookEventRepositoryPort = {
  async recordIfNew() {
    return true;
  },
};

const fakeActivityLogRepository: ActivityLogRepositoryPort = {
  async record() {
    // not used
  },
};

/**
 * Phase 6's dashboard reads. Every method is creator-scoped by the port itself
 * (there is no unscoped variant to fake), so this fake answers `null` — the
 * "not yours / does not exist" answer — for everything.
 */
const fakeAnalyticsRepository: AnalyticsRepositoryPort = {
  async getMetricsForCreator() {
    return null;
  },
  async listActivityForCreator() {
    return null;
  },
  async listMembersForCreator() {
    return null;
  },
};

const fakeOutboxRepository: OutboxRepositoryPort = {
  async enqueue() {
    return { id: "fake-outbox-1" };
  },
  async enqueueMany(inputs) {
    return inputs.map((_, index) => ({ id: `fake-outbox-${index + 1}` }));
  },
  async claimBatch() {
    return [];
  },
  async touchProcessing() {
    // not used
  },
  async releaseToPending() {
    return 0;
  },
  async markSent() {
    // not used
  },
  async markFailed() {
    // not used
  },
  async markPermanentlyFailed() {
    // not used
  },
  async reclaimStaleProcessing() {
    return 0;
  },
};

/** Runs the work inline — no real transaction is needed to satisfy the type. */
const fakePaymentActivationUnitOfWork: PaymentActivationUnitOfWorkPort = {
  async run(work) {
    return work({
      subscriptions: fakeSubscriptionRepository,
      webhookEvents: fakeWebhookEventRepository,
      activityLog: fakeActivityLogRepository,
      outbox: fakeOutboxRepository,
    });
  },
};

const fakeJoinRequestRepository: JoinRequestRepositoryPort = {
  async createPending() {
    return null;
  },
  async findById() {
    return null;
  },
  async listPendingForCommunity() {
    return [];
  },
  async findNotificationContext() {
    return null;
  },
  async decide() {
    return false;
  },
};

/** Runs the work inline — no real transaction is needed to satisfy the type. */
const fakeJoinRequestUnitOfWork: JoinRequestUnitOfWorkPort = {
  async run(work) {
    return work({
      joinRequests: fakeJoinRequestRepository,
      outbox: fakeOutboxRepository,
      activityLog: fakeActivityLogRepository,
      // Task 4's addition to the port — `createActiveWithoutBilling` runs in
      // the same transaction as `joinRequests.decide` now.
      subscriptions: fakeSubscriptionRepository,
    });
  },
};

/**
 * `RevokeChannelAccess` is a concrete class with private members, so — like the
 * other use-cases above — the fake is a REAL instance wrapping hand-written fake
 * ports. Nothing here reaches a database or a provider.
 */
const fakeChannelMembershipRepository: ChannelMembershipRepositoryPort = {
  async claim() {
    throw new Error("not used");
  },
  async recordGrant() {
    return true;
  },
  async releaseMintWindow() {
    // not used
  },
  async recordPlatformMemberIdByInviteLink() {
    return { outcome: "unknown_invite_link" };
  },
  async revoke() {
    return false;
  },
  async listActiveForMemberInCommunity() {
    return [];
  },
  async findByIdWithChannel() {
    return null;
  },
};

const fakeMessagingProvider: MessagingProviderPort = {
  platform: "telegram",
  capabilities() {
    return { canGateAccess: true };
  },
  async grantAccess() {
    throw new Error("not used");
  },
  async revokeInviteLink() {
    // not used
  },
  async revokeAccess() {
    // not used
  },
  async notify() {
    throw new Error("not used");
  },
};

const fakePaymentProvider: PaymentProviderPort = {
  async createPaymentAccount() {
    return { accountId: "fake-acct" };
  },
  async createInvoice() {
    throw new Error("not used");
  },
};

describe("Dependencies (composition root contract)", () => {
  it("accepts a hand-written fake CreatorRepositoryPort with no casts", async () => {
    const stored: CreatorRecord[] = [];

    const fakeCreatorRepository: CreatorRepositoryPort = {
      async create(input) {
        const record: CreatorRecord = {
          id: `fake-${stored.length + 1}`,
          name: input.name,
          whatsappNumber: input.whatsappNumber ?? null,
          email: input.email ?? null,
          tierPlan: "starter",
          xenditAccountId: null,
          createdAt: new Date(0),
        };
        stored.push(record);
        return record;
      },
      async findById(id) {
        return stored.find((record) => record.id === id) ?? null;
      },
      async findByEmail(email) {
        return stored.find((record) => record.email === email) ?? null;
      },
      async findCredentialsByEmail() {
        return null;
      },
      // Mirrors the real repository's three conditional UPDATEs: only the caller
      // that finds the column EMPTY claims it, and only the caller holding the
      // sentinel may replace or release it.
      async beginXenditAccountProvisioning(id) {
        const record = stored.find((r) => r.id === id);
        if (!record || record.xenditAccountId !== null) return false;
        record.xenditAccountId = XENDIT_ACCOUNT_PROVISIONING;
        return true;
      },
      async finishXenditAccountProvisioning(id, accountId) {
        const record = stored.find((r) => r.id === id);
        if (!record || record.xenditAccountId !== XENDIT_ACCOUNT_PROVISIONING) return false;
        record.xenditAccountId = accountId;
        return true;
      },
      async abandonXenditAccountProvisioning(id) {
        const record = stored.find((r) => r.id === id);
        if (!record || record.xenditAccountId !== XENDIT_ACCOUNT_PROVISIONING) return false;
        record.xenditAccountId = null;
        return true;
      },
    };

    const deps: Dependencies = {
      creatorRepository: fakeCreatorRepository,
      tokenIssuer: fakeTokenIssuer,
      payments: fakePaymentProvider,
      email: null,
      registerCreator: new RegisterCreator(
        fakeCreatorRepository,
        fakePasswordHasher,
        fakeTokenIssuer
      ),
      authenticateCreator: new AuthenticateCreator(
        fakeCreatorRepository,
        fakePasswordHasher,
        fakeTokenIssuer
      ),
      userRepository: fakeUserRepository,
      userTokenIssuer: fakeUserTokenIssuer,
      registerUser: new RegisterUser(
        fakeUserRepository,
        fakePasswordHasher,
        null,
        fakeMessagingProvider,
        fakeSignupNoticeRepository,
        fakeClock
      ),
      authenticateUser: new AuthenticateUser(
        fakeUserRepository,
        fakePasswordHasher,
        fakeUserTokenIssuer
      ),
      getUserProfile: new GetUserProfile(fakeUserRepository, fakeFollowRepository),
      updateUserProfile: new UpdateUserProfile(fakeUserRepository),
      followUser: new FollowUser(fakeUserRepository, fakeFollowRepository),
      listFollows: new ListFollows(fakeUserRepository, fakeFollowRepository),
      exploreUsers: new ExploreUsers(fakeUserRepository, fakeFollowRepository),
      createPost: new CreatePost(fakePostRepository),
      editPost: new EditPost(fakePostRepository),
      deletePost: new DeletePost(fakePostRepository),
      listFeed: new ListFeed(fakePostRepository),
      listUserPosts: new ListUserPosts(fakeUserRepository, fakePostRepository),
      requestPasswordReset: new RequestPasswordReset(
        fakeUserRepository,
        fakePasswordResetRepository,
        null,
        fakeMessagingProvider,
        fakeClock,
        { appBaseUrl: "https://app.diudara.test" }
      ),
      completePasswordReset: new CompletePasswordReset(
        fakePasswordResetRepository,
        fakePasswordHasher,
        new FakePasswordResetUnitOfWork(),
        fakeClock
      ),
      createCommunity: new CreateCommunity(fakeCommunityRepository),
      listCommunities: new ListCommunities(fakeCommunityRepository),
      updateCommunity: new UpdateCommunity(fakeCommunityRepository),
      getCommunity: new GetCommunity(fakeCommunityRepository),
      defineTier: new DefineMembershipTier(fakeCommunityRepository, fakeMembershipTierRepository),
      listTiers: new ListTiers(fakeCommunityRepository, fakeMembershipTierRepository),
      updateTier: new UpdateTier(fakeCommunityRepository, fakeMembershipTierRepository),
      connectChannel: new ConnectChannel(fakeCommunityRepository, fakeChannelRepository),
      listChannels: new ListChannels(fakeCommunityRepository, fakeChannelRepository),
      createPaymentAccount: new CreatePaymentAccount(fakeCreatorRepository, fakePaymentProvider),
      getPaymentAccountStatus: new GetPaymentAccountStatus(fakeCreatorRepository),
      getPublicCommunity: new GetPublicCommunity(
        fakeCommunityRepository,
        fakeMembershipTierRepository
      ),
      startCheckout: new StartCheckout(
        fakeCommunityRepository,
        fakeMembershipTierRepository,
        fakeMemberRepository,
        fakeSubscriptionRepository,
        fakeCreatorRepository,
        fakePaymentProvider,
        fakeClock,
        { appBaseUrl: "https://app.diudara.test" }
      ),
      requestToJoin: new RequestToJoin(
        fakeCommunityRepository,
        fakeMembershipTierRepository,
        fakeMemberRepository,
        fakeSubscriptionRepository,
        fakeJoinRequestUnitOfWork
      ),
      getJoinRequestStatus: new GetJoinRequestStatus(
        fakeCommunityRepository,
        fakeJoinRequestRepository,
        fakeSubscriptionRepository
      ),
      listJoinRequests: new ListJoinRequests(fakeCommunityRepository, fakeJoinRequestRepository),
      decideJoinRequest: new DecideJoinRequest(
        fakeCommunityRepository,
        fakeMembershipTierRepository,
        fakeJoinRequestRepository,
        fakeSubscriptionRepository,
        fakeJoinRequestUnitOfWork
      ),
      getSubscriptionStatus: new GetSubscriptionStatus(fakeSubscriptionRepository, fakeEventRepository, {
        streamTokenSecret: undefined,
      }),
      handlePaymentWebhook: new HandlePaymentWebhook(
        fakeSubscriptionRepository,
        fakePaymentActivationUnitOfWork,
        fakeClock
      ),
      getCommunityMetrics: new GetCommunityMetrics(fakeAnalyticsRepository),
      getCommunityActivity: new GetCommunityActivity(fakeAnalyticsRepository),
      listCommunityMembers: new ListCommunityMembers(fakeAnalyticsRepository),
      exportCommunityMembers: new ExportCommunityMembers(
        fakeCommunityRepository,
        fakeAnalyticsRepository
      ),
      revokeChannelAccess: new RevokeChannelAccess(
        fakeCommunityRepository,
        fakeChannelMembershipRepository,
        fakeActivityLogRepository,
        new Map([["telegram", fakeMessagingProvider]]),
        fakeOutboxRepository
      ),
      recordChannelJoin: new RecordChannelJoin(fakeChannelMembershipRepository),
      sendRenewalReminder: new SendRenewalReminder(
        fakeSubscriptionRepository,
        fakeMemberRepository,
        fakeActivityLogRepository,
        fakeMessagingProvider,
        { appBaseUrl: "https://app.diudara.test" }
      ),
      messaging: {
        gating: new Map([["telegram", fakeMessagingProvider]]),
        notifier: fakeMessagingProvider,
      },
      telegramWebhookSecret: "fake-telegram-webhook-secret",
      xenditCallbackToken: "fake-callback-token",
      appBaseUrl: "https://app.diudara.test",
      sql: async () => [{ one: 1 }],
      // Phase 7's AI co-builder. `undefined` is a valid value of both fields
      // (the feature disabled) and needs no fake use-case to satisfy the
      // type — these two tests are not about the AI path.
      aiProvider: undefined,
      sendAiMessage: undefined,
      // Task 2's streaming provider. Same reasoning: `undefined` (disabled)
      // needs no fake adapter to satisfy the type, and these tests are not
      // about the streaming path.
      streamingProvider: undefined,
      // Task 3's scheduling endpoints. `scheduleLiveSession` mirrors
      // `streamingProvider`'s undefined-ness for the same reason;
      // `listLiveSessions` is never undefined, so it needs a fake here even
      // though these tests are not about the streaming path either.
      scheduleLiveSession: undefined,
      listLiveSessions: new ListLiveSessions(fakeEventRepository),
      // Task 4's authorisation webhook. `authoriseStream` mirrors
      // `scheduleLiveSession`'s undefined-ness for the same reason (needs
      // STREAM_TOKEN_SECRET, which is absent here); these tests are not
      // about the streaming path.
      authoriseStream: undefined,
      mediamtxWebhookSecret: undefined,
      // Task 5's lifecycle webhook. Same undefined-ness reasoning as `authoriseStream`.
      handleStreamLifecycle: undefined,
      // Task 8's `GET /c/watch/:token`. Same undefined-ness reasoning as `authoriseStream`.
      resolveWatchToken: undefined,
      // Phase 4's image storage. Never undefined/null in a real Dependencies —
      // see `mediaStorage`'s own field docstring — so this needs a real fake,
      // unlike the streaming fields just above.
      mediaStorage: new FakeMediaStorageAdapter(),
      // Task 4's upload endpoint. Never undefined/null either — mirrors
      // `mediaStorage` just above. Neither of these two tests calls
      // `uploadMedia.execute`, so its repository fake (the module-level
      // `fakeMediaRepository`) never needs to do anything but satisfy the
      // port's shape.
      uploadMedia: new UploadMedia(fakeMediaRepository, new FakeMediaStorageAdapter()),
      // Task 5's delivery routes. Same fake as `uploadMedia` above — neither
      // test calls `mediaRepository.findById` either.
      mediaRepository: fakeMediaRepository,
    };

    const created = await deps.creatorRepository.create({
      name: "Fake Creator",
      whatsappNumber: "+6281000000000",
      email: "fake@example.com",
    });

    expect(await deps.creatorRepository.findByEmail("fake@example.com")).toEqual(created);
    expect(await deps.creatorRepository.findById("nope")).toBeNull();
  });

  it("lets a fully faked Dependencies drive the app with no database", async () => {
    const fakeCreatorRepository: CreatorRepositoryPort = {
      async create() {
        throw new Error("not used");
      },
      async findById() {
        return null;
      },
      async findByEmail() {
        return null;
      },
      async findCredentialsByEmail() {
        return null;
      },
      async beginXenditAccountProvisioning() {
        return false;
      },
      async finishXenditAccountProvisioning() {
        return false;
      },
      async abandonXenditAccountProvisioning() {
        return false;
      },
    };

    const deps: Dependencies = {
      creatorRepository: fakeCreatorRepository,
      tokenIssuer: fakeTokenIssuer,
      payments: fakePaymentProvider,
      email: null,
      registerCreator: new RegisterCreator(
        fakeCreatorRepository,
        fakePasswordHasher,
        fakeTokenIssuer
      ),
      authenticateCreator: new AuthenticateCreator(
        fakeCreatorRepository,
        fakePasswordHasher,
        fakeTokenIssuer
      ),
      userRepository: fakeUserRepository,
      userTokenIssuer: fakeUserTokenIssuer,
      registerUser: new RegisterUser(
        fakeUserRepository,
        fakePasswordHasher,
        null,
        fakeMessagingProvider,
        fakeSignupNoticeRepository,
        fakeClock
      ),
      authenticateUser: new AuthenticateUser(
        fakeUserRepository,
        fakePasswordHasher,
        fakeUserTokenIssuer
      ),
      getUserProfile: new GetUserProfile(fakeUserRepository, fakeFollowRepository),
      updateUserProfile: new UpdateUserProfile(fakeUserRepository),
      followUser: new FollowUser(fakeUserRepository, fakeFollowRepository),
      listFollows: new ListFollows(fakeUserRepository, fakeFollowRepository),
      exploreUsers: new ExploreUsers(fakeUserRepository, fakeFollowRepository),
      createPost: new CreatePost(fakePostRepository),
      editPost: new EditPost(fakePostRepository),
      deletePost: new DeletePost(fakePostRepository),
      listFeed: new ListFeed(fakePostRepository),
      listUserPosts: new ListUserPosts(fakeUserRepository, fakePostRepository),
      requestPasswordReset: new RequestPasswordReset(
        fakeUserRepository,
        fakePasswordResetRepository,
        null,
        fakeMessagingProvider,
        fakeClock,
        { appBaseUrl: "https://app.diudara.test" }
      ),
      completePasswordReset: new CompletePasswordReset(
        fakePasswordResetRepository,
        fakePasswordHasher,
        new FakePasswordResetUnitOfWork(),
        fakeClock
      ),
      createCommunity: new CreateCommunity(fakeCommunityRepository),
      listCommunities: new ListCommunities(fakeCommunityRepository),
      updateCommunity: new UpdateCommunity(fakeCommunityRepository),
      getCommunity: new GetCommunity(fakeCommunityRepository),
      defineTier: new DefineMembershipTier(fakeCommunityRepository, fakeMembershipTierRepository),
      listTiers: new ListTiers(fakeCommunityRepository, fakeMembershipTierRepository),
      updateTier: new UpdateTier(fakeCommunityRepository, fakeMembershipTierRepository),
      connectChannel: new ConnectChannel(fakeCommunityRepository, fakeChannelRepository),
      listChannels: new ListChannels(fakeCommunityRepository, fakeChannelRepository),
      createPaymentAccount: new CreatePaymentAccount(fakeCreatorRepository, fakePaymentProvider),
      getPaymentAccountStatus: new GetPaymentAccountStatus(fakeCreatorRepository),
      getPublicCommunity: new GetPublicCommunity(
        fakeCommunityRepository,
        fakeMembershipTierRepository
      ),
      startCheckout: new StartCheckout(
        fakeCommunityRepository,
        fakeMembershipTierRepository,
        fakeMemberRepository,
        fakeSubscriptionRepository,
        fakeCreatorRepository,
        fakePaymentProvider,
        fakeClock,
        { appBaseUrl: "https://app.diudara.test" }
      ),
      requestToJoin: new RequestToJoin(
        fakeCommunityRepository,
        fakeMembershipTierRepository,
        fakeMemberRepository,
        fakeSubscriptionRepository,
        fakeJoinRequestUnitOfWork
      ),
      getJoinRequestStatus: new GetJoinRequestStatus(
        fakeCommunityRepository,
        fakeJoinRequestRepository,
        fakeSubscriptionRepository
      ),
      listJoinRequests: new ListJoinRequests(fakeCommunityRepository, fakeJoinRequestRepository),
      decideJoinRequest: new DecideJoinRequest(
        fakeCommunityRepository,
        fakeMembershipTierRepository,
        fakeJoinRequestRepository,
        fakeSubscriptionRepository,
        fakeJoinRequestUnitOfWork
      ),
      getSubscriptionStatus: new GetSubscriptionStatus(fakeSubscriptionRepository, fakeEventRepository, {
        streamTokenSecret: undefined,
      }),
      handlePaymentWebhook: new HandlePaymentWebhook(
        fakeSubscriptionRepository,
        fakePaymentActivationUnitOfWork,
        fakeClock
      ),
      getCommunityMetrics: new GetCommunityMetrics(fakeAnalyticsRepository),
      getCommunityActivity: new GetCommunityActivity(fakeAnalyticsRepository),
      listCommunityMembers: new ListCommunityMembers(fakeAnalyticsRepository),
      exportCommunityMembers: new ExportCommunityMembers(
        fakeCommunityRepository,
        fakeAnalyticsRepository
      ),
      revokeChannelAccess: new RevokeChannelAccess(
        fakeCommunityRepository,
        fakeChannelMembershipRepository,
        fakeActivityLogRepository,
        new Map([["telegram", fakeMessagingProvider]]),
        fakeOutboxRepository
      ),
      recordChannelJoin: new RecordChannelJoin(fakeChannelMembershipRepository),
      sendRenewalReminder: new SendRenewalReminder(
        fakeSubscriptionRepository,
        fakeMemberRepository,
        fakeActivityLogRepository,
        fakeMessagingProvider,
        { appBaseUrl: "https://app.diudara.test" }
      ),
      messaging: {
        gating: new Map([["telegram", fakeMessagingProvider]]),
        notifier: fakeMessagingProvider,
      },
      telegramWebhookSecret: "fake-telegram-webhook-secret",
      xenditCallbackToken: "fake-callback-token",
      appBaseUrl: "https://app.diudara.test",
      sql: async () => [{ one: 1 }],
      // Phase 7's AI co-builder. `undefined` is a valid value of both fields
      // (the feature disabled) and needs no fake use-case to satisfy the
      // type — these two tests are not about the AI path.
      aiProvider: undefined,
      sendAiMessage: undefined,
      // Task 2's streaming provider. Same reasoning: `undefined` (disabled)
      // needs no fake adapter to satisfy the type, and these tests are not
      // about the streaming path.
      streamingProvider: undefined,
      // Task 3's scheduling endpoints. `scheduleLiveSession` mirrors
      // `streamingProvider`'s undefined-ness for the same reason;
      // `listLiveSessions` is never undefined, so it needs a fake here even
      // though these tests are not about the streaming path either.
      scheduleLiveSession: undefined,
      listLiveSessions: new ListLiveSessions(fakeEventRepository),
      // Task 4's authorisation webhook. `authoriseStream` mirrors
      // `scheduleLiveSession`'s undefined-ness for the same reason (needs
      // STREAM_TOKEN_SECRET, which is absent here); these tests are not
      // about the streaming path.
      authoriseStream: undefined,
      mediamtxWebhookSecret: undefined,
      // Task 5's lifecycle webhook. Same undefined-ness reasoning as `authoriseStream`.
      handleStreamLifecycle: undefined,
      // Task 8's `GET /c/watch/:token`. Same undefined-ness reasoning as `authoriseStream`.
      resolveWatchToken: undefined,
      // Phase 4's image storage. Never undefined/null in a real Dependencies —
      // see `mediaStorage`'s own field docstring — so this needs a real fake,
      // unlike the streaming fields just above.
      mediaStorage: new FakeMediaStorageAdapter(),
      // Task 4's upload endpoint. Never undefined/null either — mirrors
      // `mediaStorage` just above. Neither of these two tests calls
      // `uploadMedia.execute`, so its repository fake (the module-level
      // `fakeMediaRepository`) never needs to do anything but satisfy the
      // port's shape.
      uploadMedia: new UploadMedia(fakeMediaRepository, new FakeMediaStorageAdapter()),
      // Task 5's delivery routes. Same fake as `uploadMedia` above — neither
      // test calls `mediaRepository.findById` either.
      mediaRepository: fakeMediaRepository,
    };

    const res = await createApp(deps).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

/**
 * Runs `fn` with JWT_SECRET set to `value` (or unset for `undefined`), always
 * restoring the original.
 *
 * The plan's own verification command for this guard —
 * `env -u JWT_SECRET bun -e "..."` — is BROKEN: Bun auto-loads `apps/api/.env`,
 * which re-supplies JWT_SECRET after the shell unset, so it prints "NO THROW"
 * even when the guard works. That false negative is why no test existed. Set
 * the variable in-process instead; nothing re-reads `.env` afterwards.
 */
function withJwtSecret(value: string | undefined, fn: () => void) {
  const original = process.env.JWT_SECRET;
  try {
    if (value === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = value;
    }
    fn();
  } finally {
    if (original === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = original;
    }
  }
}

const PLACEHOLDER = "change_me_to_a_long_random_string";

describe("bootstrap() JWT_SECRET guard", () => {
  it("refuses to start when JWT_SECRET is unset", () => {
    withJwtSecret(undefined, () => {
      expect(() => bootstrap()).toThrow(/JWT_SECRET is not set/);
    });
  });

  it("refuses the .env.example placeholder", () => {
    // It is 33 characters, so a length check alone would wave it through — and
    // it is the value every fresh `cp .env.example .env` starts with.
    withJwtSecret(PLACEHOLDER, () => {
      expect(() => bootstrap()).toThrow(/placeholder/);
    });
  });

  it("refuses a secret shorter than 32 characters", () => {
    // `JWT_SECRET=some-secret` booted fine. HS256 with a short key is
    // brute-forceable offline from one captured token, and that token forges
    // every creator's session.
    withJwtSecret("some-secret", () => {
      expect(() => bootstrap()).toThrow(/too short/);
    });
  });

  it("accepts a 32-character secret", () => {
    withJwtSecret("x".repeat(32), () => {
      expect(() => bootstrap()).not.toThrow();
    });
  });

  it("rejects one character below the limit", () => {
    withJwtSecret("x".repeat(31), () => {
      expect(() => bootstrap()).toThrow(/too short/);
    });
  });

  it("rejects the exact JWT_SECRET line shipped in .env.example", () => {
    // Pins the guard to the file rather than to a copy of its value: if
    // .env.example's placeholder is ever reworded, this fails instead of
    // silently letting the new placeholder through.
    const example = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
    const line = example.split("\n").find((l) => l.startsWith("JWT_SECRET="));
    expect(line).toBeDefined();

    const shipped = line!.slice("JWT_SECRET=".length).trim();
    expect(shipped).toBe(PLACEHOLDER);
    withJwtSecret(shipped, () => {
      expect(() => bootstrap()).toThrow();
    });
  });
});

/**
 * I1, final whole-branch review. `APP_BASE_URL` is the origin the payment
 * provider redirects a paying member back to, so a deployment that silently used
 * the localhost default would send every payer to a page on their own machine —
 * a failure that looks exactly like the payment vanishing. Same allowlist as the
 * two payment guards, for the same reason.
 */
describe("resolveAppBaseUrl", () => {
  it("defaults to the Vite dev origin in development and test", () => {
    for (const nodeEnv of ["development", "test"]) {
      expect(resolveAppBaseUrl({ appBaseUrl: undefined, nodeEnv })).toBe(DEFAULT_APP_BASE_URL);
    }
  });

  it("refuses to default for ANY nodeEnv outside the allowlist, including unset", () => {
    for (const nodeEnv of [undefined, "staging", "prod", "PRODUCTION", "production", ""]) {
      expect(() => resolveAppBaseUrl({ appBaseUrl: undefined, nodeEnv })).toThrow(
        /APP_BASE_URL is not set/
      );
    }
  });

  it("uses a configured value everywhere", () => {
    expect(
      resolveAppBaseUrl({ appBaseUrl: "https://diudara.example", nodeEnv: "production" })
    ).toBe("https://diudara.example");
  });

  it("strips trailing slashes so a rooted path does not double up", () => {
    // The caller concatenates `/c/<slug>/status/<id>`; "https://x//c/..." is a
    // different URL and would 404.
    expect(resolveAppBaseUrl({ appBaseUrl: "https://x/", nodeEnv: "test" })).toBe("https://x");
    expect(resolveAppBaseUrl({ appBaseUrl: "https://x///", nodeEnv: "test" })).toBe("https://x");
  });

  it("treats empty and whitespace-only as unset", () => {
    for (const blank of ["", "   ", "\t"]) {
      expect(resolveAppBaseUrl({ appBaseUrl: blank, nodeEnv: "test" })).toBe(
        DEFAULT_APP_BASE_URL
      );
      expect(() => resolveAppBaseUrl({ appBaseUrl: blank, nodeEnv: "production" })).toThrow(
        /APP_BASE_URL is not set/
      );
    }
  });

  it("refuses a value that is not an http(s) origin", () => {
    // It is handed to a third party who redirects a browser to it.
    for (const bad of ["diudara.example", "javascript:alert(1)", "ftp://x", "//evil.example"]) {
      expect(() => resolveAppBaseUrl({ appBaseUrl: bad, nodeEnv: "test" })).toThrow(
        /must start with https:\/\/ or http:\/\//
      );
    }
  });
});

describe("bootstrap() APP_BASE_URL", () => {
  it("builds a checkout redirect from the configured origin", async () => {
    // End-to-end through the composition root: the value in the environment has
    // to reach the invoice, or the confirmation page is unreachable again.
    withJwtSecret("x".repeat(32), () => {
      withEnv({ APP_BASE_URL: "https://wired.example/" }, () => {
        const deps = bootstrap();
        expect(deps.payments).toBeInstanceOf(FakePaymentAdapter);
        expect(deps.appBaseUrl).toBe("https://wired.example");
      });
    });
  });

  /**
   * Phase 5's reminder delivery is DISPATCHED by the worker, but it is built here too,
   * from the same resolved `appBaseUrl` `StartCheckout` gets — so the link in a reminder
   * and the `success_redirect_url` in an invoice cannot disagree about which deployment
   * a member is sent to. Constructing it is the assertion: it is the only thing that
   * fails if the field is dropped from the root while the type still has it.
   *
   * The FUNCTIONAL proof that the origin reaches a sent message lives in
   * worker-bootstrap.test.ts, because the worker is the process that sends.
   */
  it("also builds the renewal reminder sender, so the two roots cannot drift", async () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv({ APP_BASE_URL: "https://wired.example/" }, () => {
        const deps = bootstrap();
        expect(deps.sendRenewalReminder).toBeInstanceOf(SendRenewalReminder);
        // The notifier it was handed is the WhatsApp one, not a gating provider:
        // TelegramBotAdapter.notify throws.
        expect(deps.messaging.notifier.capabilities().canGateAccess).toBe(false);
      });
    });
  });
});

describe(".env.example", () => {
  /**
   * The other half of the C1 fix, and the half code alone cannot express: the
   * allowlist only lets `bun run dev` work if a developer's `.env` actually
   * carries a NODE_ENV, and the only thing that puts one there is this line in
   * the file they copy. Before the fix `grep NODE_ENV .env.example` matched
   * prose in a comment and no assignment at all.
   */
  it("ships an actual NODE_ENV assignment, not just prose about it", () => {
    const example = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
    const line = example.split("\n").find((l) => l.startsWith("NODE_ENV="));
    expect(line).toBeDefined();

    const shipped = line!.slice("NODE_ENV=".length).trim();
    // Whatever it says must be a value the allowlist accepts, or a fresh clone
    // cannot boot.
    expect([...RELAXED_NODE_ENVS]).toContain(shipped);
    expect(() =>
      selectPaymentProvider({ secretKey: undefined, splitRuleId: undefined, nodeEnv: shipped })
    ).not.toThrow();
  });

  it("documents APP_BASE_URL, without which the confirmation page is unreachable", () => {
    const example = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
    expect(example).toContain("APP_BASE_URL=");
  });

  /**
   * The messaging tokens are what turn a payment into access. They ship COMMENTED
   * OUT, exactly like the Xendit ones: an uncommented empty value is
   * indistinguishable from a typo, and absence is a meaningful state here (it
   * selects FakeMessagingAdapter under the NODE_ENV allowlist).
   */
  it("documents the messaging tokens as commented placeholders", () => {
    const example = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
    const lines = example.split("\n");

    for (const name of ["TELEGRAM_BOT_TOKEN", "FONNTE_API_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]) {
      const line = lines.find((l) => l.trim().startsWith(`# ${name}=`));
      expect(line).toBeDefined();
      // No committed value — these are bearer credentials.
      expect(line!.trim()).toBe(`# ${name}=`);
      // And no ACTIVE assignment, which would make an empty token look configured.
      expect(lines.some((l) => l.startsWith(`${name}=`))).toBe(false);
    }

    // The half a comment has to carry that code cannot: absence is a choice, and
    // it is only allowed on the allowlist.
    expect(example).toContain("FakeMessagingAdapter");
    for (const nodeEnv of [...RELAXED_NODE_ENVS]) {
      expect(example).toContain(nodeEnv);
    }
  });

  it("tells an operator how to install the Telegram webhook, including allowed_updates", () => {
    // The one step nothing in the code can do for them, and the one that silently
    // breaks everything if it is missed: Telegram does NOT send `chat_member`
    // updates unless `allowed_updates` asks for them, so a bot with a webhook
    // installed the obvious way records no member ids at all and revocation stays
    // unautomatable with no error anywhere.
    const example = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
    expect(example).toContain("setWebhook");
    expect(example).toContain("secret_token=");
    expect(example).toContain("allowed_updates");
    expect(example).toContain("chat_member");
  });

  /**
   * Same shape as the messaging-tokens test above, extended to five
   * variables: all five ship as commented placeholders with no committed
   * value, and the file names both the fallback adapter and the allowlist
   * that permits it, so a reader relying on this file alone (not the source)
   * can still find out what an absent value does.
   */
  it("documents the five streaming variables as commented placeholders, set together or not at all", () => {
    const example = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
    const lines = example.split("\n");

    for (const name of [
      "MEDIAMTX_RTMP_HOST",
      "MEDIAMTX_HLS_BASE_URL",
      "MEDIAMTX_WHIP_BASE_URL",
      "MEDIAMTX_WEBHOOK_SECRET",
      "STREAM_TOKEN_SECRET",
    ]) {
      const line = lines.find((l) => l.trim().startsWith(`# ${name}=`));
      expect(line).toBeDefined();
      expect(line!.trim()).toBe(`# ${name}=`);
      expect(lines.some((l) => l.startsWith(`${name}=`))).toBe(false);
    }

    expect(example).toContain("FakeStreamingAdapter");
    for (const nodeEnv of [...RELAXED_NODE_ENVS]) {
      expect(example).toContain(nodeEnv);
    }
    // STREAM_TOKEN_SECRET must never be confused with JWT_SECRET — the two
    // secrets protect different things and a compromise of one must not be
    // a compromise of the other (watch-token.ts's own docstring).
    expect(example).toContain("JWT_SECRET");
  });

  /**
   * Same shape as the streaming test above, for Task 2's five S3 variables —
   * except the file must ALSO say what makes this pair unlike every other one
   * in the file: absence block-boots outside the allowlist rather than
   * degrading, so a reader relying on this file alone must be told that too.
   */
  it("documents the five S3 variables as commented placeholders, set together or not at all, and names Biznet Gio NEO", () => {
    const example = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
    const lines = example.split("\n");

    for (const name of [
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_BUCKET",
      "S3_ENDPOINT",
      "S3_REGION",
    ]) {
      const line = lines.find((l) => l.trim().startsWith(`# ${name}=`));
      expect(line).toBeDefined();
      expect(line!.trim()).toBe(`# ${name}=`);
      expect(lines.some((l) => l.startsWith(`${name}=`))).toBe(false);
    }

    expect(example).toContain("FakeMediaStorageAdapter");
    expect(example).toContain("Biznet Gio NEO");
    for (const nodeEnv of [...RELAXED_NODE_ENVS]) {
      expect(example).toContain(nodeEnv);
    }
  });
});

/**
 * Runs `fn` with each of `vars` set to its given value (or unset when the
 * value is `undefined`), always restoring the originals — same rationale as
 * `withJwtSecret` above: Bun auto-loads `apps/api/.env`, so mutating
 * `process.env` in-process (rather than via the shell) is what actually takes
 * effect for a call to `bootstrap()` made inside `fn`.
 */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** Captures `console.log` calls made during `fn`, restoring it afterwards. */
function captureConsoleLog(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("selectPaymentProvider", () => {
  it("selects XenditPaymentAdapter when both env vars are set", () => {
    const provider = selectPaymentProvider({
      secretKey: "sk_live_x",
      splitRuleId: "splitrule_1",
      nodeEnv: "test",
    });
    expect(provider).toBeInstanceOf(XenditPaymentAdapter);
  });

  it("selects the real adapter in production when fully configured", () => {
    // The other half of the production guard: a correctly configured
    // production box must still boot.
    const logs = captureConsoleLog(() => {
      const provider = selectPaymentProvider({
        secretKey: "sk_live_x",
        splitRuleId: "splitrule_1",
        nodeEnv: "production",
      });
      expect(provider).toBeInstanceOf(XenditPaymentAdapter);
    });
    expect(logs.some((line) => /XenditPaymentAdapter/.test(line))).toBe(true);
  });

  it("selects FakePaymentAdapter when both env vars are unset in development or test", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of ["test", "development"]) {
        expect(
          selectPaymentProvider({ secretKey: undefined, splitRuleId: undefined, nodeEnv })
        ).toBeInstanceOf(FakePaymentAdapter);
      }
    });
  });

  // Task 2 (free communities): this used to THROW — refusing to boot at all.
  // Free communities (`access_mode = "request"`) made that the wrong default:
  // a box can be entirely useful with no payment provider, so this now
  // returns `null` and the box boots with payments disabled instead. The
  // NEGATIVE assertion is the one that matters here, not just the `null`: a
  // future "helpful" fallback to the fake adapter must not satisfy this test
  // (see the CRITICAL comment above this describe block's predecessor tests
  // — `FakePaymentAdapter` writes unrecoverable `fake-acct-*` ids into
  // `creator.xendit_account_id`).
  it("disables payments (returns null, never the fake adapter) in production with no Xendit configuration", () => {
    const logs = captureConsoleLog(() => {
      const provider = selectPaymentProvider({
        secretKey: undefined,
        splitRuleId: undefined,
        nodeEnv: "production",
      });
      expect(provider).toBeNull();
      expect(provider).not.toBeInstanceOf(FakePaymentAdapter);
    });
    expect(logs.some((line) => /payments are DISABLED/.test(line))).toBe(true);
  });

  // CRITICAL, second pass. The `nodeEnv === "production"` denylist above was
  // never reachable on a real deployment: nothing in this repository sets
  // NODE_ENV (no `start` script, no Dockerfile, no API service in
  // infra/docker-compose.yml), so `bun -e 'console.log(process.env.NODE_ENV)'`
  // printed `undefined` and the guard silently returned FakePaymentAdapter.
  // The allowlist is what closes that: anything not explicitly relaxed gets
  // `null` (disabled), never the fake.
  it("returns null (never the fake adapter) for ANY nodeEnv outside the allowlist, including unset", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of [
        undefined,
        "staging",
        "prod",
        "PRODUCTION",
        "Production",
        "dev",
        "development ",
        "",
      ]) {
        const provider = selectPaymentProvider({ secretKey: undefined, splitRuleId: undefined, nodeEnv });
        expect(provider).toBeNull();
        expect(provider).not.toBeInstanceOf(FakePaymentAdapter);
      }
    });
  });

  it("says whether NODE_ENV was unset or merely unrecognised, in the disabled log line", () => {
    // An operator staring at "NODE_ENV is production" when they never set it
    // would look in the wrong place. There is no throw to carry this any
    // more, so it has to survive in the log message instead.
    const unset = captureConsoleLog(() => {
      selectPaymentProvider({ secretKey: undefined, splitRuleId: undefined, nodeEnv: undefined });
    });
    expect(unset.some((line) => /NODE_ENV is not set/.test(line))).toBe(true);

    const staging = captureConsoleLog(() => {
      selectPaymentProvider({ secretKey: undefined, splitRuleId: undefined, nodeEnv: "staging" });
    });
    expect(staging.some((line) => /NODE_ENV is staging/.test(line))).toBe(true);
  });

  it("still starts on the allowlist when Xendit IS configured, whatever nodeEnv says", () => {
    // The allowlist gates the FAKE adapter, not the real one: an unrecognised
    // NODE_ENV on a properly configured box must not block a deployment.
    captureConsoleLog(() => {
      for (const nodeEnv of [undefined, "staging", "prod", "production"]) {
        expect(
          selectPaymentProvider({
            secretKey: "sk_live_x",
            splitRuleId: "splitrule_1",
            nodeEnv,
          })
        ).toBeInstanceOf(XenditPaymentAdapter);
      }
    });
  });

  it("treats empty-string configuration as unset in production", () => {
    // `XENDIT_SECRET_KEY=` in a .env file arrives as "", not undefined.
    captureConsoleLog(() => {
      const provider = selectPaymentProvider({ secretKey: "", splitRuleId: "", nodeEnv: "production" });
      expect(provider).toBeNull();
      expect(provider).not.toBeInstanceOf(FakePaymentAdapter);
    });
  });

  it("refuses to start on partial configuration in EVERY environment", () => {
    // Never intentional: an operator who typo'd XENDIT_SPLIT_RULE_ID believes
    // payments are live. Failing in dev/test is what surfaces the typo before
    // it reaches production.
    for (const nodeEnv of ["test", "development", "production", undefined]) {
      expect(() =>
        selectPaymentProvider({ secretKey: "sk_live_x", splitRuleId: undefined, nodeEnv })
      ).toThrow(/half-configured/);
      expect(() =>
        selectPaymentProvider({ secretKey: undefined, splitRuleId: "splitrule_1", nodeEnv })
      ).toThrow(/half-configured/);
    }
  });

  it("treats an empty string as unset when detecting partial configuration", () => {
    expect(() =>
      selectPaymentProvider({ secretKey: "sk_live_x", splitRuleId: "   ", nodeEnv: "test" })
    ).toThrow(/half-configured/);
  });

  it("names the missing variable, not the one that is set", () => {
    expect(() =>
      selectPaymentProvider({ secretKey: "sk_live_x", splitRuleId: undefined, nodeEnv: "test" })
    ).toThrow(/XENDIT_SECRET_KEY is set but XENDIT_SPLIT_RULE_ID is not/);
  });

  it("stays silent under NODE_ENV=test and speaks up everywhere else", () => {
    // One line per bootstrap() call printed 100+ times in a full suite run and
    // buried a genuine `unhandled error` line.
    const quiet = captureConsoleLog(() => {
      selectPaymentProvider({ secretKey: undefined, splitRuleId: undefined, nodeEnv: "test" });
    });
    expect(quiet).toEqual([]);

    const loud = captureConsoleLog(() => {
      selectPaymentProvider({
        secretKey: undefined,
        splitRuleId: undefined,
        nodeEnv: "development",
      });
    });
    expect(loud.some((line) => /FakePaymentAdapter/.test(line))).toBe(true);
  });
});

describe("bootstrap() payment provider selection", () => {
  it("wires XenditPaymentAdapter when XENDIT_SECRET_KEY and XENDIT_SPLIT_RULE_ID are set", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        { XENDIT_SECRET_KEY: "sk_live_x", XENDIT_SPLIT_RULE_ID: "splitrule_1" },
        () => {
          const deps = bootstrap();
          expect(deps.payments).toBeInstanceOf(XenditPaymentAdapter);
        }
      );
    });
  });

  it("wires FakePaymentAdapter when Xendit env vars are absent", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        { XENDIT_SECRET_KEY: undefined, XENDIT_SPLIT_RULE_ID: undefined },
        () => {
          const deps = bootstrap();
          expect(deps.payments).toBeInstanceOf(FakePaymentAdapter);
        }
      );
    });
  });

  // Task 2 (free communities): used to throw here — see selectPaymentProvider's
  // own rewritten tests above for the full reasoning. Reads NODE_ENV from the
  // environment, so this pins the WIRING too, not just selectPaymentProvider in
  // isolation: `deps.startCheckout` must be `undefined` (not constructed) and
  // `deps.payments` must be `null`, never a fake.
  //
  // CORRECTION (fix round 1): an earlier version of this comment claimed the
  // original test (a Xendit-only `withEnv` override asserting `.toThrow(/NODE_ENV
  // is production/)`) "was never testing payments at all". That is FALSE —
  // verified by mutation at the pre-Task-2 commit (`a2047ea`): changing only
  // selectPaymentProvider's own throw message made that exact test fail, with the
  // received message coming from selectPaymentProvider (it runs before
  // selectMessagingProviders in bootstrap()'s call order, `bootstrap.ts:1347` vs
  // `:1459` at that commit), so it genuinely and correctly pinned payments'
  // pre-fix throw.
  //
  // The real, narrower problem is that the assertion was too LOOSE to stay
  // meaningful once selectPaymentProvider stopped throwing for this case:
  // `selectMessagingProviders` ALSO throws outside the allowlist when
  // unconfigured (unaffected by this task, and that guard stays), with a message
  // that happens to also match `/NODE_ENV is production/` — so a version of this
  // test left unchanged after the fix would keep "passing" whether or not the
  // fix actually landed, unable to distinguish the two. That is a real weakness,
  // and rewriting it — fully configuring every OTHER provider (messaging in
  // particular, mirroring the "boots with the co-builder disabled..." isolation
  // pattern further down this file) and asserting the specific fields below — is
  // strictly stronger. It does not mean the guard this replaced was ever
  // meaningless.
  it("boots a production process with no Xendit configuration — payments disabled, not the fake adapter", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        {
          NODE_ENV: "production",
          APP_BASE_URL: "http://localhost:5173",
          XENDIT_SECRET_KEY: undefined,
          XENDIT_SPLIT_RULE_ID: undefined,
          XENDIT_CALLBACK_TOKEN: undefined,
          TELEGRAM_BOT_TOKEN: "123456:real-bot-token",
          FONNTE_API_TOKEN: "real-fonnte-token",
          TELEGRAM_WEBHOOK_SECRET: REAL_TELEGRAM_WEBHOOK_SECRET,
          ...REAL_S3_CONFIG,
        },
        () => {
          captureConsoleLog(() => {
            let deps: Dependencies;
            expect(() => {
              deps = bootstrap();
            }).not.toThrow();
            expect(deps!.payments).toBeNull();
            expect(deps!.payments).not.toBeInstanceOf(FakePaymentAdapter);
            expect(deps!.startCheckout).toBeUndefined();
            expect(deps!.createPaymentAccount).toBeUndefined();
            expect(deps!.xenditCallbackToken).toBeUndefined();
          });
        }
      );
    });
  });

  it("refuses to boot on partial Xendit configuration", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv({ XENDIT_SECRET_KEY: "sk_live_x", XENDIT_SPLIT_RULE_ID: undefined }, () => {
        expect(() => bootstrap()).toThrow(/half-configured/);
      });
    });
  });
});

/**
 * `XENDIT_CALLBACK_TOKEN` is the ONLY thing authenticating `POST
 * /webhooks/xendit` — Xendit signs nothing, it just presents a static header.
 * Nothing read the variable before Task 7, so it sat outside the configuration
 * guard; these tests pin it inside, at the SAME thresholds as
 * `XENDIT_SECRET_KEY`/`XENDIT_SPLIT_RULE_ID` (owner ruling, 2026-08-09):
 * partial configuration throws everywhere, absent configuration throws only in
 * production, and a developer can boot without it.
 */
const CONFIGURED_XENDIT = { secretKey: "sk_live_x", splitRuleId: "splitrule_1" };
const NO_XENDIT = { secretKey: undefined, splitRuleId: undefined };

/**
 * A stand-in for a real Xendit dashboard token. Long enough to clear the
 * 32-character floor `resolveCallbackToken` now enforces — the previous
 * 14-character "xnd_real_token" would (correctly) be refused, and `"x"` used to
 * be accepted in production on the strength of nothing.
 */
const REAL_CALLBACK_TOKEN = `xnd_${"R".repeat(40)}`;

/**
 * A fully-configured, syntactically valid S3 setup — no real bucket exists at
 * this endpoint. `selectMediaStorage` now block-boots `NODE_ENV=production`
 * with no S3 vars set (Task 2, images), so every test in this file that
 * simulates a production box to isolate some OTHER provider's own disabled
 * path (payments/email/AI/streaming) must supply this too, or `bootstrap()`
 * throws on media storage before it ever reaches the guard under test — same
 * reasoning as `TELEGRAM_WEBHOOK_SECRET` joining those same blocks in Task 7b.
 */
const REAL_S3_CONFIG = {
  S3_ACCESS_KEY_ID: "test-s3-access-key",
  S3_SECRET_ACCESS_KEY: "test-s3-secret-key",
  S3_BUCKET: "test-bucket",
  S3_ENDPOINT: "https://s3.test.example.com",
  S3_REGION: "id-jkt-1",
};

describe("resolveCallbackToken", () => {
  it("uses a configured token as-is", () => {
    expect(
      resolveCallbackToken({
        callbackToken: REAL_CALLBACK_TOKEN,
        ...CONFIGURED_XENDIT,
        nodeEnv: "production",
      })
    ).toBe(REAL_CALLBACK_TOKEN);
  });

  // MINOR from the final review: JWT_SECRET beside it requires 32 characters,
  // while this — the webhook's ONLY authentication — accepted "x" in
  // production. Same floor, same reasoning.
  it("refuses a token shorter than 32 characters, in EVERY environment", () => {
    for (const nodeEnv of ["production", "development", "test", undefined]) {
      for (const short of ["x", "xnd_short", "a".repeat(31)]) {
        expect(() =>
          resolveCallbackToken({ callbackToken: short, ...NO_XENDIT, nodeEnv })
        ).toThrow(/XENDIT_CALLBACK_TOKEN is too short/);
      }
      expect(
        resolveCallbackToken({ callbackToken: "a".repeat(32), ...NO_XENDIT, nodeEnv })
      ).toBe("a".repeat(32));
    }
  });

  it("names the length it got and the length it needs", () => {
    expect(() =>
      resolveCallbackToken({ callbackToken: "x", ...NO_XENDIT, nodeEnv: "production" })
    ).toThrow(/\(1 characters; 32 required\)/);
  });

  it("defaults ONLY under NODE_ENV=test", () => {
    // The tests have to send a token they know. Same NODE_ENV mechanism
    // resetDatabase() already relies on to avoid truncating a real database.
    expect(
      resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv: "test" })
    ).toBe(TEST_CALLBACK_TOKEN);
  });

  it("lets a DEVELOPER boot without it, like the Xendit keys next to it", () => {
    // The point of the owner ruling: a developer must not have to configure an
    // endpoint they may never exercise locally. `undefined` is safe —
    // verifyCallbackToken refuses an unset expected token, so the route rejects
    // every delivery instead of accepting any.
    captureConsoleLog(() => {
      expect(
        resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv: "development" })
      ).toBeUndefined();
    });
  });

  // CRITICAL, second pass — the same relocation as selectPaymentProvider's
  // guard used to require. "staging" and an UNSET NODE_ENV used to boot
  // happily with no callback token, and an unset NODE_ENV is what a real
  // deployment has, because nothing in this repository sets it. That danger —
  // money taken, nobody activated, no loud failure — only exists when Xendit
  // itself is actually configured; `NO_XENDIT` here means it is not, so
  // Task 2 (free communities) changed this case from a throw to `undefined`:
  // mirrors selectPaymentProvider's own null branch, because with no Xendit
  // keys at all there is no invoice this webhook could ever be asked to
  // authenticate. The PARTIAL-configuration throw right below this block is
  // untouched — that is the case where the danger is real.
  it("returns undefined (not a throw) for ANY nodeEnv outside the allowlist, once Xendit itself is unconfigured", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of [
        undefined,
        "staging",
        "prod",
        "PRODUCTION",
        "Production",
        "dev",
        "",
      ]) {
        expect(
          resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv })
        ).toBeUndefined();
      }
    });
  });

  it("distinguishes an unset NODE_ENV from an unrecognised one in the disabled log line too", () => {
    const unset = captureConsoleLog(() => {
      resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv: undefined });
    });
    expect(unset.some((line) => /NODE_ENV is not set/.test(line))).toBe(true);

    const staging = captureConsoleLog(() => {
      resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv: "staging" });
    });
    expect(staging.some((line) => /NODE_ENV is staging/.test(line))).toBe(true);
  });

  it("says so out loud in development, and stays quiet under test", () => {
    const loud = captureConsoleLog(() => {
      resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv: "development" });
    });
    expect(loud.some((line) => /XENDIT_CALLBACK_TOKEN not set/.test(line))).toBe(true);

    const quiet = captureConsoleLog(() => {
      resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv: "test" });
    });
    expect(quiet).toEqual([]);
  });

  it("boots in production with no callback token, once Xendit itself is disabled too", () => {
    captureConsoleLog(() => {
      expect(
        resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv: "production" })
      ).toBeUndefined();
    });
  });

  it("refuses to start on PARTIAL configuration in every environment", () => {
    // Real invoices would be created and no callback could be authenticated, so
    // nobody who paid would ever be activated. Same reasoning as
    // selectPaymentProvider's half-configured check, extended to the third var.
    for (const nodeEnv of ["development", "production", "staging", undefined]) {
      expect(() =>
        resolveCallbackToken({ callbackToken: undefined, ...CONFIGURED_XENDIT, nodeEnv })
      ).toThrow(/half-configured/);
    }
  });

  it("treats empty and whitespace-only configuration as unset", () => {
    // `XENDIT_CALLBACK_TOKEN=` in a .env file arrives as "", and a value pasted
    // out of a dashboard with a trailing newline is not configuration either.
    captureConsoleLog(() => {
      for (const blank of ["", "   ", "\t", "\n"]) {
        // Xendit itself is also unconfigured (NO_XENDIT), so this is the
        // disabled case: undefined, not a throw — see the rewritten tests
        // above.
        expect(
          resolveCallbackToken({ callbackToken: blank, ...NO_XENDIT, nodeEnv: "production" })
        ).toBeUndefined();
        expect(
          resolveCallbackToken({ callbackToken: blank, ...NO_XENDIT, nodeEnv: "test" })
        ).toBe(TEST_CALLBACK_TOKEN);
      }
    });
  });

  it("refuses the committed test token outside tests", () => {
    // It is in this repository in plain text, so it would authenticate a forged
    // payment event for anyone who can read the source.
    for (const nodeEnv of ["production", "development", undefined]) {
      expect(() =>
        resolveCallbackToken({
          callbackToken: TEST_CALLBACK_TOKEN,
          ...NO_XENDIT,
          nodeEnv,
        })
      ).toThrow(/committed to this repository/);
    }
  });

  it("never returns an empty string, which would vouch for an empty header", () => {
    // undefined is fine — verifyCallbackToken refuses it. "" would once have
    // matched a request sending `X-CALLBACK-TOKEN:` with no value.
    for (const nodeEnv of ["test", "development"]) {
      const token = resolveCallbackTokenQuietly(nodeEnv);
      expect(token).not.toBe("");
    }
  });

  it("mentions the file an operator has to edit", () => {
    // NO_XENDIT no longer throws here (see the rewritten tests above) — the
    // remaining throw in this branch needs Xendit to be MIXED, not absent: one
    // key set is neither "fully configured" (selectPaymentProvider's own job)
    // nor "fully disabled", so this box genuinely still needs the callback
    // token. In practice selectPaymentProvider would already have refused to
    // boot over the same half-configured Xendit before bootstrap() ever calls
    // this function — this exercises resolveCallbackToken defensively, in
    // isolation.
    expect(() =>
      resolveCallbackToken({
        callbackToken: undefined,
        secretKey: "sk_live_x",
        splitRuleId: undefined,
        nodeEnv: "production",
      })
    ).toThrow(/apps\/api\/\.env/);
  });
});

/** `resolveCallbackToken` with its development warning swallowed. */
function resolveCallbackTokenQuietly(nodeEnv: string | undefined): string | undefined {
  let token: string | undefined;
  captureConsoleLog(() => {
    token = resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv });
  });
  return token;
}

describe("bootstrap() XENDIT_CALLBACK_TOKEN guard", () => {
  it("wires the configured token into Dependencies", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv({ XENDIT_CALLBACK_TOKEN: REAL_CALLBACK_TOKEN }, () => {
        expect(bootstrap().xenditCallbackToken).toBe(REAL_CALLBACK_TOKEN);
      });
    });
  });

  it("falls back to the test token under bun test, so the suite can sign webhooks", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv({ XENDIT_CALLBACK_TOKEN: undefined }, () => {
        expect(bootstrap().xenditCallbackToken).toBe(TEST_CALLBACK_TOKEN);
      });
    });
  });

  it("boots a DEVELOPMENT process with no callback token", () => {
    // `bun run dev` must work on a fresh clone that never touched Xendit.
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        {
          NODE_ENV: "development",
          XENDIT_CALLBACK_TOKEN: undefined,
          XENDIT_SECRET_KEY: undefined,
          XENDIT_SPLIT_RULE_ID: undefined,
        },
        () => {
          captureConsoleLog(() => {
            expect(bootstrap().xenditCallbackToken).toBeUndefined();
          });
        }
      );
    });
  });

  it("refuses to boot a fully-configured process with no callback token", () => {
    // The worst case: real money moves, and nothing can credit it. Throws in
    // development too, because this combination is never intentional.
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        {
          NODE_ENV: "development",
          XENDIT_SECRET_KEY: "sk_live_x",
          XENDIT_SPLIT_RULE_ID: "splitrule_1",
          XENDIT_CALLBACK_TOKEN: undefined,
        },
        () => {
          captureConsoleLog(() => {
            expect(() => bootstrap()).toThrow(/half-configured/);
          });
        }
      );
    });
  });

  it("refuses to boot a production process with no callback token", () => {
    withJwtSecret("x".repeat(32), () => {
      // APP_BASE_URL is set explicitly, not inherited. Durable rule: a test must
      // set every environment variable its assertion depends on — inheriting one
      // from apps/api/.env instead makes the test pass only on a machine that has
      // that file; a fresh clone and CI both fail without this override.
      //
      // Concretely here: bootstrap()'s guards run assertUsableJwtSecret (first) ->
      // selectPaymentProvider -> resolveCallbackToken -> resolveAppBaseUrl ->
      // selectMessagingProviders (last), so APP_BASE_URL is the FOURTH guard, not
      // the first. Without it, resolveAppBaseUrl throws before this fully-configured
      // block ever reaches selectMessagingProviders — and `expect(() =>
      // bootstrap()).not.toThrow()` below fails, because bootstrap() throws when it
      // must not.
      withEnv(
        {
          NODE_ENV: "production",
          APP_BASE_URL: "http://localhost:5173",
          XENDIT_SECRET_KEY: "sk_live_x",
          XENDIT_SPLIT_RULE_ID: "splitrule_1",
          XENDIT_CALLBACK_TOKEN: REAL_CALLBACK_TOKEN,
          // Phase 4: the API now selects messaging providers too (revocation is
          // synchronous), under the same allowlist. A production box must
          // configure them, so "fully configured" means all SIX variables —
          // TELEGRAM_WEBHOOK_SECRET joined the set in Task 7b, because a bot token
          // without it means no member's Telegram user id is ever recorded and the
          // creator can never remove anybody.
          TELEGRAM_BOT_TOKEN: "123456:real-bot-token",
          FONNTE_API_TOKEN: "real-fonnte-token",
          TELEGRAM_WEBHOOK_SECRET: REAL_TELEGRAM_WEBHOOK_SECRET,
          ...REAL_S3_CONFIG,
        },
        () => {
          captureConsoleLog(() => {
            expect(() => bootstrap()).not.toThrow();
          });
        }
      );

      // Task 2 (free communities): this used to assert a throw here too — with
      // NOTHING configured at all, `selectPaymentProvider` used to speak
      // first ("you are about to take fake money") before this guard ever
      // got a turn. Now that Xendit-absent boots with payments disabled
      // (see selectPaymentProvider's own rewritten tests), this box boots —
      // provided messaging is still configured, since THAT guard is
      // unaffected by this task and still throws when absent outside the
      // allowlist. `xenditCallbackToken` is asserted `undefined` directly,
      // which is what this test is actually about.
      withEnv(
        {
          NODE_ENV: "production",
          APP_BASE_URL: "http://localhost:5173",
          XENDIT_SECRET_KEY: undefined,
          XENDIT_SPLIT_RULE_ID: undefined,
          XENDIT_CALLBACK_TOKEN: undefined,
          TELEGRAM_BOT_TOKEN: "123456:real-bot-token",
          FONNTE_API_TOKEN: "real-fonnte-token",
          TELEGRAM_WEBHOOK_SECRET: REAL_TELEGRAM_WEBHOOK_SECRET,
          ...REAL_S3_CONFIG,
        },
        () => {
          captureConsoleLog(() => {
            let deps: Dependencies;
            expect(() => {
              deps = bootstrap();
            }).not.toThrow();
            expect(deps!.xenditCallbackToken).toBeUndefined();
            expect(deps!.payments).toBeNull();
          });
        }
      );
    });
  });
});

describe("bootstrap() messaging provider selection", () => {
  it("refuses to boot a production process with no messaging tokens", () => {
    // Reached through bootstrap(), not just the selector in isolation: the API
    // process performs REVOCATION, and a fake adapter there would report a
    // removal it never performed.
    //
    // APP_BASE_URL is set explicitly, not inherited, for the same reason as the
    // callback-token tests above: resolveAppBaseUrl is the guard immediately
    // before selectMessagingProviders, so without it bootstrap() would throw
    // there instead of reaching the messaging guard this test targets.
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        {
          NODE_ENV: "production",
          APP_BASE_URL: "http://localhost:5173",
          XENDIT_SECRET_KEY: "sk_live_x",
          XENDIT_SPLIT_RULE_ID: "splitrule_1",
          XENDIT_CALLBACK_TOKEN: REAL_CALLBACK_TOKEN,
          TELEGRAM_BOT_TOKEN: undefined,
          FONNTE_API_TOKEN: undefined,
        },
        () => {
          captureConsoleLog(() => {
            expect(() => bootstrap()).toThrow(/TELEGRAM_BOT_TOKEN and FONNTE_API_TOKEN/);
          });
        }
      );
    });
  });

  it("wires the revocation use-case, so the route is not calling nothing", () => {
    const deps = bootstrap();
    // A wiring assertion, like the appBaseUrl one: Phase 3 shipped a whole phase
    // with an unreachable confirmation page because nothing checked the root.
    expect(deps.revokeChannelAccess).toBeInstanceOf(RevokeChannelAccess);
  });
});

describe("selectMessagingProviders", () => {
  it("selects the real adapters when both tokens are set", () => {
    const providers = captureConsoleLogValue(() =>
      selectMessagingProviders({
        telegramBotToken: "123456:real-bot-token",
        fonnteApiToken: "real-fonnte-token",
        nodeEnv: "production",
      })
    );

    expect(providers.gating.get("telegram")).toBeInstanceOf(TelegramBotAdapter);
    // WhatsApp is in the GATING map on purpose: a whatsapp channel must resolve
    // to a provider that reports `canGateAccess: false` — which the grant
    // use-case turns into "a human will add you" — rather than to nothing, which
    // it treats as an unwired platform and an error.
    expect(providers.gating.get("whatsapp")).toBeInstanceOf(FonnteWhatsAppAdapter);
    expect(providers.notifier).toBeInstanceOf(FonnteWhatsAppAdapter);
  });

  it("selects the fake adapters when neither token is set, in development or test", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of [...RELAXED_NODE_ENVS]) {
        const providers = selectMessagingProviders({
          telegramBotToken: undefined,
          fonnteApiToken: undefined,
          nodeEnv,
        });
        expect(providers.gating.get("telegram")).toBeInstanceOf(FakeMessagingAdapter);
        expect(providers.notifier).toBeInstanceOf(FakeMessagingAdapter);
      }
    });
  });

  /**
   * Same allowlist, same reason as the payment adapter: a box that looks like it
   * is inviting paying members while only appending to an array is this phase's
   * worst failure mode — the member appears granted and is not.
   */
  it("refuses to start for ANY nodeEnv outside the allowlist, including unset", () => {
    for (const nodeEnv of [undefined, "staging", "prod", "PRODUCTION", "dev", "", "production"]) {
      expect(() =>
        selectMessagingProviders({
          telegramBotToken: undefined,
          fonnteApiToken: undefined,
          nodeEnv,
        })
      ).toThrow(/permitted ONLY/);
    }
  });

  it("refuses HALF configuration in every environment", () => {
    // A set Telegram token with no Fonnte token means invites are created and
    // never delivered: the member pays, a link is minted, and nobody is told.
    expect(() =>
      selectMessagingProviders({
        telegramBotToken: "123456:real",
        fonnteApiToken: undefined,
        nodeEnv: "test",
      })
    ).toThrow(/FONNTE_API_TOKEN/);

    expect(() =>
      selectMessagingProviders({
        telegramBotToken: undefined,
        fonnteApiToken: "real",
        nodeEnv: "test",
      })
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("treats a blank token as unset rather than as configuration", () => {
    captureConsoleLog(() => {
      const providers = selectMessagingProviders({
        telegramBotToken: "   ",
        fonnteApiToken: "",
        nodeEnv: "test",
      });
      expect(providers.gating.get("telegram")).toBeInstanceOf(FakeMessagingAdapter);
    });
  });

  it("keeps the tokens out of the startup log line", () => {
    const lines = captureConsoleLog(() => {
      selectMessagingProviders({
        telegramBotToken: "123456:AA-secret-bot-token",
        fonnteApiToken: "secret-fonnte-token",
        nodeEnv: "production",
      });
    });

    const printed = lines.join("\n");
    expect(printed).not.toContain("AA-secret-bot-token");
    expect(printed).not.toContain("secret-fonnte-token");
  });
});

describe("selectEmailProvider", () => {
  it("selects ResendEmailAdapter when both env vars are set", () => {
    const provider = selectEmailProvider({
      apiKey: "re_live_x",
      from: "DIUDARA <no-reply@diudara.example>",
      nodeEnv: "test",
    });
    expect(provider).toBeInstanceOf(ResendEmailAdapter);
  });

  it("selects the real adapter in production when fully configured", () => {
    const logs = captureConsoleLog(() => {
      const provider = selectEmailProvider({
        apiKey: "re_live_x",
        from: "DIUDARA <no-reply@diudara.example>",
        nodeEnv: "production",
      });
      expect(provider).toBeInstanceOf(ResendEmailAdapter);
    });
    expect(logs.some((line) => /ResendEmailAdapter/.test(line))).toBe(true);
  });

  it("selects FakeEmailAdapter when both env vars are unset in development or test", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of ["test", "development"]) {
        expect(
          selectEmailProvider({ apiKey: undefined, from: undefined, nodeEnv })
        ).toBeInstanceOf(FakeEmailAdapter);
      }
    });
  });

  // CRITICAL — the row a previous phase got wrong. The NEGATIVE assertion is
  // the one that matters, not just the null: a future "helpful" fallback to
  // the fake adapter would satisfy a loose `expect(provider).toBeFalsy()` (or
  // even `toBeNull()`, if the fallback itself returned null on some OTHER
  // path) while silently reintroducing exactly the hazard this guard exists
  // to prevent — a box that looks like it sends real email and only records
  // sends into an array nobody reads.
  it("disables email (returns null, never the fake adapter) in production with no email configuration", () => {
    const logs = captureConsoleLog(() => {
      const provider = selectEmailProvider({
        apiKey: undefined,
        from: undefined,
        nodeEnv: "production",
      });
      expect(provider).toBeNull();
      expect(provider).not.toBeInstanceOf(FakeEmailAdapter);
    });
    expect(logs.some((line) => /email is DISABLED/.test(line))).toBe(true);
  });

  it("returns null (never the fake adapter) for ANY nodeEnv outside the allowlist, including unset", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of [
        undefined,
        "staging",
        "prod",
        "PRODUCTION",
        "Production",
        "dev",
        "development ",
        "",
      ]) {
        const provider = selectEmailProvider({ apiKey: undefined, from: undefined, nodeEnv });
        expect(provider).toBeNull();
        expect(provider).not.toBeInstanceOf(FakeEmailAdapter);
      }
    });
  });

  it("still starts on the allowlist when Resend IS configured, whatever nodeEnv says", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of [undefined, "staging", "prod", "production"]) {
        expect(
          selectEmailProvider({
            apiKey: "re_live_x",
            from: "DIUDARA <no-reply@diudara.example>",
            nodeEnv,
          })
        ).toBeInstanceOf(ResendEmailAdapter);
      }
    });
  });

  /**
   * The Task 7 gate finding, pinned at the WIRING rather than only inside the
   * adapter: `FakeEmailAdapter`'s own test proves `echo: true` prints, but that
   * proves nothing about the adapter this function actually hands to
   * `RequestPasswordReset` — and it was precisely a correct-in-isolation,
   * unwired component that made the reset link unobtainable in local
   * development in the first place. Both rows matter: `development` must echo
   * (or dev is broken again) and `test` must NOT (or 100+ suites start printing
   * message bodies over genuine failure output, the same hazard
   * `logProviderChoice` avoids).
   */
  it("echoes messages in development and stays silent under test", async () => {
    for (const [nodeEnv, shouldEcho] of [
      ["development", true],
      ["test", false],
    ] as const) {
      const provider = captureConsoleLogValue(() =>
        selectEmailProvider({ apiKey: undefined, from: undefined, nodeEnv })
      );
      expect(provider).toBeInstanceOf(FakeEmailAdapter);

      const lines: string[] = [];
      const original = console.log;
      console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
      try {
        await (provider as FakeEmailAdapter).send({
          to: "budi@example.com",
          subject: "Atur ulang kata sandi DIUDARA",
          body: "http://localhost:5173/reset/tok-abc",
        });
      } finally {
        console.log = original;
      }

      expect(lines.length > 0).toBe(shouldEcho);
      // The link, not merely "something was printed" — that is the whole point.
      expect(lines.join("\n").includes("http://localhost:5173/reset/tok-abc")).toBe(shouldEcho);
      // The send is recorded either way, so no existing test depends on the flag.
      expect((provider as FakeEmailAdapter).sent.length).toBe(1);
    }
  });

  it("treats empty-string configuration as unset in production", () => {
    captureConsoleLog(() => {
      const provider = selectEmailProvider({ apiKey: "", from: "", nodeEnv: "production" });
      expect(provider).toBeNull();
      expect(provider).not.toBeInstanceOf(FakeEmailAdapter);
    });
  });

  it("refuses to start on partial configuration in EVERY environment", () => {
    for (const nodeEnv of ["test", "development", "production", undefined]) {
      expect(() =>
        selectEmailProvider({ apiKey: "re_live_x", from: undefined, nodeEnv })
      ).toThrow(/half-configured/);
      expect(() =>
        selectEmailProvider({
          apiKey: undefined,
          from: "DIUDARA <no-reply@diudara.example>",
          nodeEnv,
        })
      ).toThrow(/half-configured/);
    }
  });

  it("treats an empty string as unset when detecting partial configuration", () => {
    expect(() =>
      selectEmailProvider({ apiKey: "re_live_x", from: "   ", nodeEnv: "test" })
    ).toThrow(/half-configured/);
  });

  it("names the missing variable, not the one that is set", () => {
    expect(() =>
      selectEmailProvider({ apiKey: "re_live_x", from: undefined, nodeEnv: "test" })
    ).toThrow(/RESEND_API_KEY is set but EMAIL_FROM is not/);
  });

  it("stays silent under NODE_ENV=test and speaks up everywhere else", () => {
    const quiet = captureConsoleLog(() => {
      selectEmailProvider({ apiKey: undefined, from: undefined, nodeEnv: "test" });
    });
    expect(quiet).toEqual([]);

    const loud = captureConsoleLog(() => {
      selectEmailProvider({ apiKey: undefined, from: undefined, nodeEnv: "development" });
    });
    expect(loud.some((line) => /FakeEmailAdapter/.test(line))).toBe(true);
  });

  it("keeps the API key out of the startup log line", () => {
    const lines = captureConsoleLog(() => {
      selectEmailProvider({
        apiKey: "re_SUPERSECRET_key",
        from: "DIUDARA <no-reply@diudara.example>",
        nodeEnv: "production",
      });
    });
    expect(lines.join("\n")).not.toContain("re_SUPERSECRET_key");
  });
});

describe("bootstrap() email provider selection", () => {
  it("wires ResendEmailAdapter when RESEND_API_KEY and EMAIL_FROM are set", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        { RESEND_API_KEY: "re_live_x", EMAIL_FROM: "DIUDARA <no-reply@diudara.example>" },
        () => {
          const deps = bootstrap();
          expect(deps.email).toBeInstanceOf(ResendEmailAdapter);
        }
      );
    });
  });

  it("wires FakeEmailAdapter when email env vars are absent", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv({ RESEND_API_KEY: undefined, EMAIL_FROM: undefined }, () => {
        const deps = bootstrap();
        expect(deps.email).toBeInstanceOf(FakeEmailAdapter);
      });
    });
  });

  it("boots a production process with no email configuration — email disabled, not the fake adapter", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        {
          NODE_ENV: "production",
          APP_BASE_URL: "http://localhost:5173",
          RESEND_API_KEY: undefined,
          EMAIL_FROM: undefined,
          XENDIT_SECRET_KEY: undefined,
          XENDIT_SPLIT_RULE_ID: undefined,
          XENDIT_CALLBACK_TOKEN: undefined,
          TELEGRAM_BOT_TOKEN: "123456:real-bot-token",
          FONNTE_API_TOKEN: "real-fonnte-token",
          TELEGRAM_WEBHOOK_SECRET: REAL_TELEGRAM_WEBHOOK_SECRET,
          ...REAL_S3_CONFIG,
        },
        () => {
          captureConsoleLog(() => {
            let deps: Dependencies;
            expect(() => {
              deps = bootstrap();
            }).not.toThrow();
            expect(deps!.email).toBeNull();
            expect(deps!.email).not.toBeInstanceOf(FakeEmailAdapter);
          });
        }
      );
    });
  });

  it("refuses to boot on partial email configuration", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv({ RESEND_API_KEY: "re_live_x", EMAIL_FROM: undefined }, () => {
        expect(() => bootstrap()).toThrow(/half-configured/);
      });
    });
  });
});

/** `captureConsoleLog`, for a call whose RETURN value the test also needs. */
function captureConsoleLogValue<T>(fn: () => T): T {
  let value!: T;
  captureConsoleLog(() => {
    value = fn();
  });
  return value;
}

/**
 * Task 7b. `TELEGRAM_WEBHOOK_SECRET` is the ONLY authentication on
 * `POST /webhooks/telegram`, and it is a sharper weapon than it looks: a forged
 * `chat_member` update writes an attacker-chosen `external_member_id` onto a
 * membership, and that is the id a later `banChatMember` is aimed at. Forging one
 * turns a creator's "remove this member" into "remove somebody else from my group".
 *
 * So it is held to the SAME four rules as `resolveCallbackToken` above, and these
 * tests are deliberately its mirror image.
 */
const REAL_TELEGRAM_WEBHOOK_SECRET = `tg_${"S".repeat(40)}`;
const NO_TELEGRAM_BOT = { telegramBotToken: undefined };
const CONFIGURED_TELEGRAM_BOT = { telegramBotToken: "123456:ABC-DEF" };

describe("resolveTelegramWebhookSecret", () => {
  it("uses a configured secret as-is", () => {
    expect(
      resolveTelegramWebhookSecret({
        webhookSecret: REAL_TELEGRAM_WEBHOOK_SECRET,
        ...CONFIGURED_TELEGRAM_BOT,
        nodeEnv: "production",
      })
    ).toBe(REAL_TELEGRAM_WEBHOOK_SECRET);
  });

  it("refuses a secret shorter than 32 characters, in EVERY environment", () => {
    for (const nodeEnv of ["production", "development", "test", undefined]) {
      for (const short of ["x", "tg_short", "a".repeat(31)]) {
        expect(() =>
          resolveTelegramWebhookSecret({
            webhookSecret: short,
            ...NO_TELEGRAM_BOT,
            nodeEnv,
          })
        ).toThrow(/TELEGRAM_WEBHOOK_SECRET is too short/);
      }
      expect(
        resolveTelegramWebhookSecret({
          webhookSecret: "a".repeat(32),
          ...NO_TELEGRAM_BOT,
          nodeEnv,
        })
      ).toBe("a".repeat(32));
    }
  });

  it("refuses characters Telegram's setWebhook will not accept", () => {
    // secret_token is 1-256 of A-Z a-z 0-9 _ - only. Caught at BOOT rather than as
    // an opaque 400 from setWebhook on a box whose endpoint then rejects everything.
    for (const bad of [`${"a".repeat(32)} b`, `${"a".repeat(32)}+`, `${"a".repeat(32)}=`, `å${"a".repeat(32)}`]) {
      expect(() =>
        resolveTelegramWebhookSecret({
          webhookSecret: bad,
          ...NO_TELEGRAM_BOT,
          nodeEnv: "production",
        })
      ).toThrow(/setWebhook will not accept/);
    }
    // The output of the command the error message suggests.
    expect(
      resolveTelegramWebhookSecret({
        webhookSecret: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
        ...NO_TELEGRAM_BOT,
        nodeEnv: "production",
      })
    ).toBeTruthy();
  });

  it("defaults ONLY under NODE_ENV=test", () => {
    expect(
      resolveTelegramWebhookSecret({
        webhookSecret: undefined,
        ...NO_TELEGRAM_BOT,
        nodeEnv: "test",
      })
    ).toBe(TEST_TELEGRAM_WEBHOOK_SECRET);
  });

  it("lets a DEVELOPER boot without it — a webhook needs a public URL they may not have", () => {
    captureConsoleLog(() => {
      expect(
        resolveTelegramWebhookSecret({
          webhookSecret: undefined,
          ...NO_TELEGRAM_BOT,
          nodeEnv: "development",
        })
      ).toBeUndefined();
    });
  });

  it("refuses to boot without it for ANY nodeEnv outside the allowlist", () => {
    // Including UNSET, which is what a real deployment has: nothing in this
    // repository sets NODE_ENV.
    for (const nodeEnv of [undefined, "staging", "prod", "PRODUCTION", "Production", "dev", ""]) {
      expect(() =>
        resolveTelegramWebhookSecret({ webhookSecret: undefined, ...NO_TELEGRAM_BOT, nodeEnv })
      ).toThrow(/permitted ONLY when NODE_ENV is exactly/);
    }
  });

  it("distinguishes an unset NODE_ENV from an unrecognised one", () => {
    expect(() =>
      resolveTelegramWebhookSecret({
        webhookSecret: undefined,
        ...NO_TELEGRAM_BOT,
        nodeEnv: undefined,
      })
    ).toThrow(/NODE_ENV is not set/);
    expect(() =>
      resolveTelegramWebhookSecret({
        webhookSecret: undefined,
        ...NO_TELEGRAM_BOT,
        nodeEnv: "staging",
      })
    ).toThrow(/NODE_ENV is staging/);
  });

  it("refuses to start on PARTIAL configuration in every environment", () => {
    // A bot token with no webhook secret means real invite links are issued and no
    // join can be authenticated — so no member's Telegram user id is ever recorded
    // and the creator can never remove anybody. Never intentional.
    for (const nodeEnv of ["development", "production", "staging", undefined]) {
      expect(() =>
        resolveTelegramWebhookSecret({
          webhookSecret: undefined,
          ...CONFIGURED_TELEGRAM_BOT,
          nodeEnv,
        })
      ).toThrow(/TELEGRAM_BOT_TOKEN is set but TELEGRAM_WEBHOOK_SECRET is not/);
    }
  });

  it("treats empty and whitespace-only configuration as unset", () => {
    for (const blank of ["", "   ", "\t", "\n"]) {
      expect(() =>
        resolveTelegramWebhookSecret({
          webhookSecret: blank,
          ...NO_TELEGRAM_BOT,
          nodeEnv: "production",
        })
      ).toThrow(/NODE_ENV is production/);
      expect(
        resolveTelegramWebhookSecret({ webhookSecret: blank, ...NO_TELEGRAM_BOT, nodeEnv: "test" })
      ).toBe(TEST_TELEGRAM_WEBHOOK_SECRET);
    }
  });

  it("refuses the committed test secret outside tests", () => {
    for (const nodeEnv of ["production", "development", undefined]) {
      expect(() =>
        resolveTelegramWebhookSecret({
          webhookSecret: TEST_TELEGRAM_WEBHOOK_SECRET,
          ...NO_TELEGRAM_BOT,
          nodeEnv,
        })
      ).toThrow(/committed to this repository/);
    }
  });

  it("never returns an empty string, which would vouch for an empty header", () => {
    for (const nodeEnv of ["test", "development"]) {
      let secret: string | undefined;
      captureConsoleLog(() => {
        secret = resolveTelegramWebhookSecret({
          webhookSecret: undefined,
          ...NO_TELEGRAM_BOT,
          nodeEnv,
        });
      });
      expect(secret).not.toBe("");
    }
  });

  it("says out loud in development that revocation cannot be automated without it", () => {
    const loud = captureConsoleLog(() => {
      resolveTelegramWebhookSecret({
        webhookSecret: undefined,
        ...NO_TELEGRAM_BOT,
        nodeEnv: "development",
      });
    });
    expect(loud.some((line) => /TELEGRAM_WEBHOOK_SECRET not set/.test(line))).toBe(true);
    expect(loud.some((line) => /revocation cannot be automated/.test(line))).toBe(true);

    const quiet = captureConsoleLog(() => {
      resolveTelegramWebhookSecret({
        webhookSecret: undefined,
        ...NO_TELEGRAM_BOT,
        nodeEnv: "test",
      });
    });
    expect(quiet).toEqual([]);
  });

  it("mentions the file an operator has to edit", () => {
    expect(() =>
      resolveTelegramWebhookSecret({
        webhookSecret: undefined,
        ...CONFIGURED_TELEGRAM_BOT,
        nodeEnv: "production",
      })
    ).toThrow(/apps\/api\/\.env/);
  });
});

describe("bootstrap() TELEGRAM_WEBHOOK_SECRET guard", () => {
  it("wires the configured secret into Dependencies", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv({ TELEGRAM_WEBHOOK_SECRET: REAL_TELEGRAM_WEBHOOK_SECRET }, () => {
        expect(bootstrap().telegramWebhookSecret).toBe(REAL_TELEGRAM_WEBHOOK_SECRET);
      });
    });
  });

  it("falls back to the test secret under bun test, so the suite can sign updates", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv({ TELEGRAM_WEBHOOK_SECRET: undefined }, () => {
        expect(bootstrap().telegramWebhookSecret).toBe(TEST_TELEGRAM_WEBHOOK_SECRET);
      });
    });
  });

  it("wires a RecordChannelJoin into Dependencies", () => {
    // Without it nothing populates channel_membership.external_member_id, and
    // RevokeChannelAccess can only ever report no_provider_member_id_recorded.
    withJwtSecret("x".repeat(32), () => {
      expect(bootstrap().recordChannelJoin).toBeInstanceOf(RecordChannelJoin);
    });
  });
});

describe("selectAiProvider", () => {
  it("selects OpenRouterAiAdapter when both env vars are set", () => {
    captureConsoleLog(() => {
      const provider = selectAiProvider({
        apiKey: "sk-or-x",
        model: "openai/gpt-4o-mini",
        nodeEnv: "test",
      });
      expect(provider).toBeInstanceOf(OpenRouterAiAdapter);
    });
  });

  it("selects the real adapter in production when fully configured", () => {
    const logs = captureConsoleLog(() => {
      const provider = selectAiProvider({
        apiKey: "sk-or-x",
        model: "openai/gpt-4o-mini",
        nodeEnv: "production",
      });
      expect(provider).toBeInstanceOf(OpenRouterAiAdapter);
    });
    expect(logs.some((line) => /OpenRouterAiAdapter/.test(line))).toBe(true);
  });

  it("selects FakeAiAdapter when both env vars are unset in development or test", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of ["test", "development"]) {
        expect(
          selectAiProvider({ apiKey: undefined, model: undefined, nodeEnv })
        ).toBeInstanceOf(FakeAiAdapter);
      }
    });
  });

  // THE DELIBERATE DIVERGENCE from selectPaymentProvider/selectMessagingProviders:
  // absent configuration outside the allowlist returns undefined — the feature is
  // disabled, not the boot (design spec §11).
  it("returns undefined — does NOT throw — outside the allowlist with no configuration", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of [undefined, "staging", "prod", "PRODUCTION", "production"]) {
        expect(selectAiProvider({ apiKey: undefined, model: undefined, nodeEnv })).toBeUndefined();
      }
    });
  });

  it("says out loud that the feature is disabled, outside the allowlist with no configuration", () => {
    const logs = captureConsoleLog(() => {
      selectAiProvider({ apiKey: undefined, model: undefined, nodeEnv: "production" });
    });
    expect(logs.some((line) => /AI co-builder is DISABLED/.test(line))).toBe(true);
  });

  // Gate-review finding: every OTHER fakeBehaviour test below passes
  // nodeEnv: "development" (or ambient "test") — none of them establishes
  // that the switch is INERT outside RELAXED_NODE_ENVS, which is the
  // combination that actually matters. `resolveAiFakeBehaviour` is only
  // ever called from inside the `isRelaxedNodeEnv` branch — it does not
  // even take a `nodeEnv` parameter to gate on — so this is really pinning
  // THAT CALL SITE, not a second guard inside the resolver. A refactor that
  // hoisted the resolve above the allowlist check would make a production
  // box with a stray AI_FAKE_BEHAVIOUR throw (on a typo) or, worse, serve
  // fake AI behaviour from an env var — and every other test in this file
  // would keep passing while it happened.
  it("does NOT throw and does NOT consult fakeBehaviour outside the allowlist with no configuration", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of ["production", "Development", undefined]) {
        // A VALID value must still be ignored...
        expect(
          selectAiProvider({
            apiKey: undefined,
            model: undefined,
            nodeEnv,
            fakeBehaviour: "timeout",
          })
        ).toBeUndefined();
        // ...and so must a GARBAGE one: if resolveAiFakeBehaviour were ever
        // reached here, this would throw instead of returning undefined.
        expect(
          selectAiProvider({
            apiKey: undefined,
            model: undefined,
            nodeEnv,
            fakeBehaviour: "not-a-real-behaviour",
          })
        ).toBeUndefined();
      }
    });
  });

  it("still starts on the allowlist when OpenRouter IS configured, whatever nodeEnv says", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of [undefined, "staging", "prod", "production"]) {
        expect(
          selectAiProvider({ apiKey: "sk-or-x", model: "openai/gpt-4o-mini", nodeEnv })
        ).toBeInstanceOf(OpenRouterAiAdapter);
      }
    });
  });

  it("refuses to start on PARTIAL configuration in EVERY environment", () => {
    for (const nodeEnv of ["test", "development", "production", undefined]) {
      expect(() =>
        selectAiProvider({ apiKey: "sk-or-x", model: undefined, nodeEnv })
      ).toThrow(/half-configured/);
      expect(() =>
        selectAiProvider({ apiKey: undefined, model: "openai/gpt-4o-mini", nodeEnv })
      ).toThrow(/half-configured/);
    }
  });

  it("names the missing variable, not the one that is set", () => {
    expect(() =>
      selectAiProvider({ apiKey: "sk-or-x", model: undefined, nodeEnv: "test" })
    ).toThrow(/OPENROUTER_API_KEY is set but OPENROUTER_MODEL is not/);
  });

  it("treats empty and whitespace-only configuration as unset", () => {
    captureConsoleLog(() => {
      for (const blank of ["", "   "]) {
        expect(
          selectAiProvider({ apiKey: blank, model: blank, nodeEnv: "test" })
        ).toBeInstanceOf(FakeAiAdapter);
      }
    });
  });

  it("stays silent under NODE_ENV=test and speaks up everywhere else", () => {
    const quiet = captureConsoleLog(() => {
      selectAiProvider({ apiKey: undefined, model: undefined, nodeEnv: "test" });
    });
    expect(quiet).toEqual([]);

    const loud = captureConsoleLog(() => {
      selectAiProvider({ apiKey: undefined, model: undefined, nodeEnv: "development" });
    });
    expect(loud.length).toBeGreaterThan(0);
  });

  // Task 8's gate: before this, FakeAiAdapter.nextBehaviour could only be
  // set by a test holding the instance directly, so every hostile-payload
  // path (refusal, injection, malformed-JSON-> 502, timeout -> 503) was
  // unreachable from a real browser — the fake always answered "draft".
  it("sets the returned FakeAiAdapter's nextBehaviour from fakeBehaviour", () => {
    captureConsoleLog(() => {
      const provider = selectAiProvider({
        apiKey: undefined,
        model: undefined,
        nodeEnv: "development",
        fakeBehaviour: "timeout",
      }) as FakeAiAdapter;
      expect(provider).toBeInstanceOf(FakeAiAdapter);
      expect(provider.nextBehaviour).toBe("timeout");
    });
  });

  it("leaves nextBehaviour at its default when fakeBehaviour is unset", () => {
    captureConsoleLog(() => {
      const provider = selectAiProvider({
        apiKey: undefined,
        model: undefined,
        nodeEnv: "development",
      }) as FakeAiAdapter;
      expect(provider.nextBehaviour).toBe("draft");
    });
  });

  it("mentions the configured AI_FAKE_BEHAVIOUR in the startup log", () => {
    const logs = captureConsoleLog(() => {
      selectAiProvider({
        apiKey: undefined,
        model: undefined,
        nodeEnv: "development",
        fakeBehaviour: "injection",
      });
    });
    expect(logs.some((line) => /AI_FAKE_BEHAVIOUR=injection/.test(line))).toBe(true);
  });

  it("propagates resolveAiFakeBehaviour's own failure-closed guard", () => {
    expect(() =>
      selectAiProvider({
        apiKey: undefined,
        model: undefined,
        nodeEnv: "development",
        fakeBehaviour: "not-a-real-behaviour",
      })
    ).toThrow(/AI_FAKE_BEHAVIOUR must be one of/);
  });

  // Strengthened per gate review: the original version passed a VALID
  // fakeBehaviour and asserted only `instanceof OpenRouterAiAdapter`, which
  // would keep passing even if resolveAiFakeBehaviour were (wrongly) called
  // in this branch with a value that happened to validate. A GARBAGE value
  // is the assertion that actually proves the resolver is never reached
  // here at all — if it were, this would throw instead of returning the
  // real adapter.
  it("never consults fakeBehaviour in the real-adapter branch, not even to validate it", () => {
    captureConsoleLog(() => {
      const provider = selectAiProvider({
        apiKey: "sk-or-x",
        model: "openai/gpt-4o-mini",
        nodeEnv: "test",
        fakeBehaviour: "not-a-real-behaviour",
      });
      expect(provider).toBeInstanceOf(OpenRouterAiAdapter);
    });
  });
});

describe("resolveAiFakeBehaviour", () => {
  it("returns undefined when unset", () => {
    expect(resolveAiFakeBehaviour({ value: undefined })).toBeUndefined();
  });

  it("treats empty and whitespace-only as unset", () => {
    expect(resolveAiFakeBehaviour({ value: "" })).toBeUndefined();
    expect(resolveAiFakeBehaviour({ value: "   " })).toBeUndefined();
  });

  it("accepts every behaviour FakeAiAdapter itself supports", () => {
    for (const behaviour of FAKE_AI_BEHAVIOURS) {
      expect(resolveAiFakeBehaviour({ value: behaviour })).toBe(behaviour);
    }
  });

  it("fails closed on an unrecognised value rather than silently keeping the default", () => {
    expect(() => resolveAiFakeBehaviour({ value: "garbage" })).toThrow(
      /AI_FAKE_BEHAVIOUR must be one of/
    );
  });

  it("is case-sensitive — the fake's own union is lowercase-hyphenated", () => {
    expect(() => resolveAiFakeBehaviour({ value: "Draft" })).toThrow(
      /AI_FAKE_BEHAVIOUR must be one of/
    );
  });
});

describe("resolveAiDailyMessageLimit", () => {
  it("defaults to DEFAULT_AI_DAILY_MESSAGE_LIMIT when unset", () => {
    expect(resolveAiDailyMessageLimit({ value: undefined })).toBe(
      DEFAULT_AI_DAILY_MESSAGE_LIMIT
    );
  });

  it("uses a configured positive whole number", () => {
    expect(resolveAiDailyMessageLimit({ value: "10" })).toBe(10);
  });

  it("treats an empty or whitespace-only value as unset", () => {
    expect(resolveAiDailyMessageLimit({ value: "" })).toBe(DEFAULT_AI_DAILY_MESSAGE_LIMIT);
    expect(resolveAiDailyMessageLimit({ value: "   " })).toBe(DEFAULT_AI_DAILY_MESSAGE_LIMIT);
  });

  it("fails closed on a non-numeric value rather than silently allowing nothing", () => {
    expect(() => resolveAiDailyMessageLimit({ value: "abc" })).toThrow(
      /must be a positive whole number/
    );
  });

  it("fails closed on zero, a negative number, or a fraction", () => {
    for (const bad of ["0", "-5", "1.5"]) {
      expect(() => resolveAiDailyMessageLimit({ value: bad })).toThrow(
        /must be a positive whole number/
      );
    }
  });
});

describe("bootstrap() AI provider wiring", () => {
  it("wires a SendAiMessage and a FakeAiAdapter under NODE_ENV=test with no OpenRouter config", () => {
    withJwtSecret("x".repeat(32), () => {
      const deps = bootstrap();
      expect(deps.aiProvider).toBeInstanceOf(FakeAiAdapter);
      expect(deps.sendAiMessage).toBeInstanceOf(SendAiMessage);
    });
  });

  it("wires OpenRouterAiAdapter and a SendAiMessage when both env vars are configured", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        { OPENROUTER_API_KEY: "sk-or-x", OPENROUTER_MODEL: "openai/gpt-4o-mini" },
        () => {
          const deps = bootstrap();
          expect(deps.aiProvider).toBeInstanceOf(OpenRouterAiAdapter);
          expect(deps.sendAiMessage).toBeInstanceOf(SendAiMessage);
        }
      );
    });
  });

  it("wires AI_FAKE_BEHAVIOUR through to the constructed FakeAiAdapter", () => {
    // End-to-end through the composition root: the env var has to reach the
    // ACTUAL instance bootstrap() hands to SendAiMessage, not just
    // selectAiProvider in isolation — otherwise a browser-driven turn would
    // still hit the untouched default.
    withJwtSecret("x".repeat(32), () => {
      withEnv({ AI_FAKE_BEHAVIOUR: "refusal" }, () => {
        const deps = bootstrap();
        expect(deps.aiProvider).toBeInstanceOf(FakeAiAdapter);
        expect((deps.aiProvider as FakeAiAdapter).nextBehaviour).toBe("refusal");
      });
    });
  });

  it("fails closed on an invalid AI_FAKE_BEHAVIOUR rather than silently keeping the default", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv({ AI_FAKE_BEHAVIOUR: "not-a-real-behaviour" }, () => {
        expect(() => bootstrap()).toThrow(/AI_FAKE_BEHAVIOUR must be one of/);
      });
    });
  });

  it("fails closed on an invalid AI_DAILY_MESSAGE_LIMIT rather than silently keeping the default", () => {
    // This only proves resolveAiDailyMessageLimit's own guard fires from
    // inside bootstrap() — it does NOT prove a configured valid value
    // reaches SendAiMessage's constructor (hardcoding 50 there would still
    // pass this). That wiring is covered by routes/ai.test.ts's
    // AI_DAILY_MESSAGE_LIMIT=1 test, which observes the cap actually bind at
    // 1 through a real HTTP call.
    withJwtSecret("x".repeat(32), () => {
      withEnv({ AI_DAILY_MESSAGE_LIMIT: "not-a-number" }, () => {
        expect(() => bootstrap()).toThrow(/must be a positive whole number/);
      });
    });
  });

  it("boots with the co-builder disabled even when AI_DAILY_MESSAGE_LIMIT is garbage — absent/irrelevant AI config must never block boot", () => {
    // `NODE_ENV=production` with no OPENROUTER_API_KEY/OPENROUTER_MODEL is
    // exactly `selectAiProvider`'s disabled path — see "THE DELIBERATE
    // DIVERGENCE" above. Every OTHER provider is fully configured (mirrors
    // the "refuses to boot a production process with no callback token" test
    // above) so the only thing under test is the AI wiring: a fat-fingered
    // AI_DAILY_MESSAGE_LIMIT must not even be READ, let alone thrown on,
    // once the feature it belongs to is off.
    //
    // APP_BASE_URL is set explicitly, not inherited, same as every other
    // fully-configured production block in this file: resolveAppBaseUrl sits
    // between resolveCallbackToken and selectMessagingProviders in bootstrap()'s
    // guard order, so without it bootstrap() throws before it ever reaches the
    // AI wiring this test is actually about.
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        {
          NODE_ENV: "production",
          APP_BASE_URL: "http://localhost:5173",
          XENDIT_SECRET_KEY: "sk_live_x",
          XENDIT_SPLIT_RULE_ID: "splitrule_1",
          XENDIT_CALLBACK_TOKEN: REAL_CALLBACK_TOKEN,
          TELEGRAM_BOT_TOKEN: "123456:real-bot-token",
          FONNTE_API_TOKEN: "real-fonnte-token",
          TELEGRAM_WEBHOOK_SECRET: REAL_TELEGRAM_WEBHOOK_SECRET,
          OPENROUTER_API_KEY: undefined,
          OPENROUTER_MODEL: undefined,
          AI_DAILY_MESSAGE_LIMIT: "fifty",
          ...REAL_S3_CONFIG,
        },
        () => {
          captureConsoleLog(() => {
            let deps: Dependencies;
            expect(() => {
              deps = bootstrap();
            }).not.toThrow();
            expect(deps!.aiProvider).toBeUndefined();
            expect(deps!.sendAiMessage).toBeUndefined();
          });
        }
      );
    });
  });
});

const FULL_STREAMING_CONFIG = {
  rtmpHost: "stream.example.com",
  hlsBaseUrl: "https://stream.example.com/hls",
  whipBaseUrl: "https://stream.example.com",
  webhookSecret: "wh_".padEnd(32, "s"),
  streamTokenSecret: "tok_".padEnd(32, "t"),
};

describe("selectStreamingProvider", () => {
  it("selects MediaMtxAdapter when all five env vars are set", () => {
    captureConsoleLog(() => {
      const provider = selectStreamingProvider({ ...FULL_STREAMING_CONFIG, nodeEnv: "test" });
      expect(provider).toBeInstanceOf(MediaMtxAdapter);
    });
  });

  // Mirrors selectAiProvider's "still starts on the allowlist ... whatever
  // nodeEnv says": a FULLY configured streaming setup is real infrastructure
  // an operator deliberately stood up, so it must work in production, and it
  // must not be defeated by a NODE_ENV that is merely unrecognised — that
  // would make a correctly-configured production box silently disable a
  // feature it paid to configure.
  it("still selects MediaMtxAdapter regardless of NODE_ENV when fully configured", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of [undefined, "staging", "prod", "production", "Development"]) {
        expect(
          selectStreamingProvider({ ...FULL_STREAMING_CONFIG, nodeEnv })
        ).toBeInstanceOf(MediaMtxAdapter);
      }
    });
  });

  it("selects FakeStreamingAdapter when all five env vars are unset in development or test", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of ["test", "development"]) {
        expect(
          selectStreamingProvider({
            rtmpHost: undefined,
            hlsBaseUrl: undefined,
            whipBaseUrl: undefined,
            webhookSecret: undefined,
            streamTokenSecret: undefined,
            nodeEnv,
          })
        ).toBeInstanceOf(FakeStreamingAdapter);
      }
    });
  });

  // THE TEST THAT MATTERS MOST (plan Task 2): this project shipped a
  // Critical TWICE in Phase 3 from a guard that was correct in isolation but
  // whose trigger point — an unrecognised or unset NODE_ENV — was never
  // exercised by any test, so nobody noticed it was dead code until a real
  // box hit it. RELAXED_NODE_ENVS replaced a denylist with an allowlist for
  // exactly this reason (see its own docstring). This proves the allowlist
  // gate here is actually REACHED, not dead code, for:
  //   - "production": a real, recognised NODE_ENV value that simply is not
  //     on the allowlist — the shape that bit Phase 3.
  //   - "Development": a plausible misspelling of the allowed
  //     "development" — RELAXED_NODE_ENVS is a Set, not a case-insensitive
  //     check, so this MUST be treated as unrecognised.
  //   - undefined: NODE_ENV simply never set, which is what actually
  //     happened in Phase 3 (nothing in this repo sets NODE_ENV outside
  //     apps/api/.env.example).
  // crossed with streaming configuration that is genuinely ABSENT
  // (undefined) and configuration that arrives as GARBAGE whitespace — the
  // shape `presentOrUndefined` treats identically to absent, so a stray
  // `MEDIAMTX_RTMP_HOST= ` (trailing space, no value) must disable exactly
  // like an unset one, never throw, and never silently activate. In every
  // one of these twelve combinations the selector must return `undefined`
  // and must NOT throw.
  it("is inert outside RELAXED_NODE_ENVS — production, a misspelling, and unset all disable rather than throw, whether streaming config is absent or garbage whitespace", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of ["production", "Development", undefined]) {
        for (const blank of [undefined, "", "   "]) {
          expect(
            selectStreamingProvider({
              rtmpHost: blank,
              hlsBaseUrl: blank,
              whipBaseUrl: blank,
              webhookSecret: blank,
              streamTokenSecret: blank,
              nodeEnv,
            })
          ).toBeUndefined();
        }
      }
    });
  });

  it("says out loud that streaming is disabled, outside the allowlist with no configuration", () => {
    const logs = captureConsoleLog(() => {
      selectStreamingProvider({
        rtmpHost: undefined,
        hlsBaseUrl: undefined,
        whipBaseUrl: undefined,
        webhookSecret: undefined,
        streamTokenSecret: undefined,
        nodeEnv: "production",
      });
    });
    expect(logs.some((line) => /live streaming is DISABLED/.test(line))).toBe(true);
  });

  it("refuses to start on PARTIAL configuration in EVERY environment", () => {
    for (const nodeEnv of ["test", "development", "production", undefined]) {
      for (const missingKey of Object.keys(FULL_STREAMING_CONFIG) as Array<
        keyof typeof FULL_STREAMING_CONFIG
      >) {
        const partial = { ...FULL_STREAMING_CONFIG, [missingKey]: undefined, nodeEnv };
        expect(() => selectStreamingProvider(partial)).toThrow(/half-configured/);
      }
    }
  });

  it("names which variables are set and which are missing", () => {
    expect(() =>
      selectStreamingProvider({
        ...FULL_STREAMING_CONFIG,
        streamTokenSecret: undefined,
        nodeEnv: "test",
      })
    ).toThrow(/MEDIAMTX_RTMP_HOST.*STREAM_TOKEN_SECRET not/s);
  });

  // A short secret must fail LOUDLY at boot even under the allowlist — the
  // length floor is a hard security property (MIN_STREAMING_SECRET_LENGTH),
  // not a production-only concern, exactly like JWT_SECRET's own floor.
  it("refuses a MEDIAMTX_WEBHOOK_SECRET shorter than 32 characters, even under NODE_ENV=test", () => {
    expect(() =>
      selectStreamingProvider({ ...FULL_STREAMING_CONFIG, webhookSecret: "short", nodeEnv: "test" })
    ).toThrow(/MEDIAMTX_WEBHOOK_SECRET is too short/);
  });

  it("refuses a STREAM_TOKEN_SECRET shorter than 32 characters, even under NODE_ENV=test", () => {
    expect(() =>
      selectStreamingProvider({
        ...FULL_STREAMING_CONFIG,
        streamTokenSecret: "short",
        nodeEnv: "test",
      })
    ).toThrow(/STREAM_TOKEN_SECRET is too short/);
  });

  it("stays silent under NODE_ENV=test and speaks up everywhere else", () => {
    const quiet = captureConsoleLog(() => {
      selectStreamingProvider({
        rtmpHost: undefined,
        hlsBaseUrl: undefined,
        whipBaseUrl: undefined,
        webhookSecret: undefined,
        streamTokenSecret: undefined,
        nodeEnv: "test",
      });
    });
    expect(quiet).toEqual([]);

    const loud = captureConsoleLog(() => {
      selectStreamingProvider({
        rtmpHost: undefined,
        hlsBaseUrl: undefined,
        whipBaseUrl: undefined,
        webhookSecret: undefined,
        streamTokenSecret: undefined,
        nodeEnv: "development",
      });
    });
    expect(loud.length).toBeGreaterThan(0);
  });
});

describe("bootstrap() streaming provider wiring", () => {
  it("wires FakeStreamingAdapter under NODE_ENV=test with no streaming config", () => {
    // "No streaming config" relies on `test-env-preload.ts` deleting all
    // five streaming env vars once, for the whole process, before any test
    // file (including this one) is even loaded — not on this machine's
    // `apps/api/.env` happening not to set them. A `beforeEach` scoped to
    // this file was tried first (review round 2) and was not enough: Bun
    // scopes a `beforeEach` to its own file, so it never ran for the ~17
    // OTHER test files with a bare `bootstrap()` call and no streaming
    // setup of their own (`routes/health.test.ts` among them). See the
    // preload's own docstring for the full reasoning.
    withJwtSecret("x".repeat(32), () => {
      const deps = bootstrap();
      expect(deps.streamingProvider).toBeInstanceOf(FakeStreamingAdapter);
    });
  });

  it("wires MediaMtxAdapter when all five streaming env vars are configured", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        {
          MEDIAMTX_RTMP_HOST: FULL_STREAMING_CONFIG.rtmpHost,
          MEDIAMTX_HLS_BASE_URL: FULL_STREAMING_CONFIG.hlsBaseUrl,
          MEDIAMTX_WHIP_BASE_URL: FULL_STREAMING_CONFIG.whipBaseUrl,
          MEDIAMTX_WEBHOOK_SECRET: FULL_STREAMING_CONFIG.webhookSecret,
          STREAM_TOKEN_SECRET: FULL_STREAMING_CONFIG.streamTokenSecret,
        },
        () => {
          const deps = bootstrap();
          expect(deps.streamingProvider).toBeInstanceOf(MediaMtxAdapter);
        }
      );
    });
  });

  // Task 2: proves MEDIAMTX_WHIP_BASE_URL actually reaches the constructed
  // adapter, not just that SOME MediaMtxAdapter got built — the same
  // "wiring, not just instantiation" gap `appBaseUrl`'s own docstring on
  // `Dependencies` warns about.
  it("wires MEDIAMTX_WHIP_BASE_URL through to a real whipUrl", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        {
          MEDIAMTX_RTMP_HOST: FULL_STREAMING_CONFIG.rtmpHost,
          MEDIAMTX_HLS_BASE_URL: FULL_STREAMING_CONFIG.hlsBaseUrl,
          MEDIAMTX_WHIP_BASE_URL: FULL_STREAMING_CONFIG.whipBaseUrl,
          MEDIAMTX_WEBHOOK_SECRET: FULL_STREAMING_CONFIG.webhookSecret,
          STREAM_TOKEN_SECRET: FULL_STREAMING_CONFIG.streamTokenSecret,
        },
        () => {
          const deps = bootstrap();
          const session = deps.streamingProvider!.createSession({ streamKey: "abc123" });
          expect(session.whipUrl).toBe("https://stream.example.com/whip/abc123");
        }
      );
    });
  });

  // Mirrors the AI provider's own "boots with the co-builder disabled even
  // when [irrelevant config] is garbage" test: a fully-configured
  // production box (payments and messaging both real) with NO streaming
  // configuration must still boot, and streamingProvider must be undefined
  // rather than throwing or silently activating a fake. The five streaming
  // vars are left OUT of the `withEnv` below deliberately — `test-env-preload.ts`
  // already guarantees they are absent for the whole run, and repeating
  // them here would only be a per-test workaround this file does not need.
  it("boots with streaming disabled on an otherwise fully-configured production box with no MediaMTX config", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        {
          NODE_ENV: "production",
          APP_BASE_URL: "http://localhost:5173",
          XENDIT_SECRET_KEY: "sk_live_x",
          XENDIT_SPLIT_RULE_ID: "splitrule_1",
          XENDIT_CALLBACK_TOKEN: REAL_CALLBACK_TOKEN,
          TELEGRAM_BOT_TOKEN: "123456:real-bot-token",
          FONNTE_API_TOKEN: "real-fonnte-token",
          TELEGRAM_WEBHOOK_SECRET: REAL_TELEGRAM_WEBHOOK_SECRET,
          ...REAL_S3_CONFIG,
        },
        () => {
          captureConsoleLog(() => {
            let deps: Dependencies;
            expect(() => {
              deps = bootstrap();
            }).not.toThrow();
            expect(deps!.streamingProvider).toBeUndefined();
          });
        }
      );
    });
  });
});

describe("bootstrap() media storage selection", () => {
  // Mirrors "refuses to boot a production process with no messaging tokens"
  // above, not the streaming/AI/email "boots ... disabled" tests: media
  // storage is the SECOND feature (after messaging) that refuses to start
  // rather than degrade — see `selectMediaStorage`'s own docstring.
  it("refuses to boot a production process with no S3 configuration", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        {
          NODE_ENV: "production",
          APP_BASE_URL: "http://localhost:5173",
          XENDIT_SECRET_KEY: "sk_live_x",
          XENDIT_SPLIT_RULE_ID: "splitrule_1",
          XENDIT_CALLBACK_TOKEN: REAL_CALLBACK_TOKEN,
          TELEGRAM_BOT_TOKEN: "123456:real-bot-token",
          FONNTE_API_TOKEN: "real-fonnte-token",
          TELEGRAM_WEBHOOK_SECRET: REAL_TELEGRAM_WEBHOOK_SECRET,
          S3_ACCESS_KEY_ID: undefined,
          S3_SECRET_ACCESS_KEY: undefined,
          S3_BUCKET: undefined,
          S3_ENDPOINT: undefined,
          S3_REGION: undefined,
        },
        () => {
          captureConsoleLog(() => {
            expect(() => bootstrap()).toThrow(/S3_ACCESS_KEY_ID.*permitted ONLY/s);
          });
        }
      );
    });
  });

  it("wires FakeMediaStorageAdapter into Dependencies under NODE_ENV=test", () => {
    const deps = bootstrap();
    expect(deps.mediaStorage).toBeInstanceOf(FakeMediaStorageAdapter);
  });

  it("wires S3MediaStorageAdapter into Dependencies once all five S3 vars are set", () => {
    withJwtSecret("x".repeat(32), () => {
      withEnv(REAL_S3_CONFIG, () => {
        captureConsoleLog(() => {
          expect(bootstrap().mediaStorage).toBeInstanceOf(S3MediaStorageAdapter);
        });
      });
    });
  });
});

const FULL_S3_CONFIG = {
  accessKeyId: "test-s3-access-key",
  secretAccessKey: "test-s3-secret-key",
  bucket: "test-bucket",
  endpoint: "https://s3.test.example.com",
  region: "id-jkt-1",
};

describe("selectMediaStorage", () => {
  it("selects S3MediaStorageAdapter when all five env vars are set", () => {
    captureConsoleLog(() => {
      const storage = selectMediaStorage({ ...FULL_S3_CONFIG, nodeEnv: "test" });
      expect(storage).toBeInstanceOf(S3MediaStorageAdapter);
    });
  });

  // Mirrors selectStreamingProvider's own "still selects ... regardless of
  // NODE_ENV when fully configured": real infrastructure an operator
  // deliberately configured must work in production, and must not be
  // defeated by a NODE_ENV that is merely unrecognised.
  it("still selects S3MediaStorageAdapter regardless of NODE_ENV when fully configured", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of [undefined, "staging", "prod", "production", "Development"]) {
        expect(selectMediaStorage({ ...FULL_S3_CONFIG, nodeEnv })).toBeInstanceOf(
          S3MediaStorageAdapter
        );
      }
    });
  });

  it("selects FakeMediaStorageAdapter when all five env vars are unset in development or test", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of [...RELAXED_NODE_ENVS]) {
        expect(
          selectMediaStorage({
            accessKeyId: undefined,
            secretAccessKey: undefined,
            bucket: undefined,
            endpoint: undefined,
            region: undefined,
            nodeEnv,
          })
        ).toBeInstanceOf(FakeMediaStorageAdapter);
      }
    });
  });

  /**
   * THE GUARD THAT MATTERS MOST for this selector (hard constraint, Task 2's
   * brief): unlike every other absence-tolerant provider in this file, a
   * missing bucket here must BLOCK BOOT — an API that accepts uploads and
   * silently keeps them in a Map that vanishes on restart is worse than one
   * that refuses to start. Same allowlist-not-denylist shape as
   * `selectMessagingProviders`'s own "refuses to start for ANY nodeEnv
   * outside the allowlist" test, for the same Phase-3-shaped reason
   * (RELAXED_NODE_ENVS's own docstring): "production", a plausible
   * misspelling, and unset must all throw, never silently disable.
   */
  it("refuses to start for ANY nodeEnv outside the allowlist, including unset", () => {
    for (const nodeEnv of [undefined, "staging", "prod", "PRODUCTION", "dev", "", "production"]) {
      expect(() =>
        selectMediaStorage({
          accessKeyId: undefined,
          secretAccessKey: undefined,
          bucket: undefined,
          endpoint: undefined,
          region: undefined,
          nodeEnv,
        })
      ).toThrow(/permitted ONLY/);
    }
  });

  it("refuses to start on PARTIAL configuration in EVERY environment", () => {
    for (const nodeEnv of ["test", "development", "production", undefined]) {
      for (const missingKey of Object.keys(FULL_S3_CONFIG) as Array<keyof typeof FULL_S3_CONFIG>) {
        const partial = { ...FULL_S3_CONFIG, [missingKey]: undefined, nodeEnv };
        expect(() => selectMediaStorage(partial)).toThrow(/half-configured/);
      }
    }
  });

  it("names which variables are set and which are missing", () => {
    expect(() =>
      selectMediaStorage({ ...FULL_S3_CONFIG, region: undefined, nodeEnv: "test" })
    ).toThrow(/S3_ACCESS_KEY_ID.*S3_REGION not/s);
  });

  it("treats a blank value as unset rather than as configuration", () => {
    captureConsoleLog(() => {
      const storage = selectMediaStorage({
        accessKeyId: "   ",
        secretAccessKey: "",
        bucket: undefined,
        endpoint: undefined,
        region: undefined,
        nodeEnv: "test",
      });
      expect(storage).toBeInstanceOf(FakeMediaStorageAdapter);
    });
  });

  it("keeps the credentials out of the startup log line", () => {
    const lines = captureConsoleLog(() => {
      selectMediaStorage({ ...FULL_S3_CONFIG, accessKeyId: "AKIA-secret", nodeEnv: "development" });
    });

    const printed = lines.join("\n");
    expect(printed).not.toContain("AKIA-secret");
    expect(printed).not.toContain(FULL_S3_CONFIG.secretAccessKey);
  });

  it("stays silent under NODE_ENV=test and speaks up everywhere else, for both the real and the fake branch", () => {
    const quietReal = captureConsoleLog(() => {
      selectMediaStorage({ ...FULL_S3_CONFIG, nodeEnv: "test" });
    });
    expect(quietReal).toEqual([]);

    const loudReal = captureConsoleLog(() => {
      selectMediaStorage({ ...FULL_S3_CONFIG, nodeEnv: "development" });
    });
    expect(loudReal.length).toBeGreaterThan(0);

    const quietFake = captureConsoleLog(() => {
      selectMediaStorage({
        accessKeyId: undefined,
        secretAccessKey: undefined,
        bucket: undefined,
        endpoint: undefined,
        region: undefined,
        nodeEnv: "test",
      });
    });
    expect(quietFake).toEqual([]);
  });
});
