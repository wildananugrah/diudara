import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bootstrap,
  DEFAULT_APP_BASE_URL,
  RELAXED_NODE_ENVS,
  resolveAppBaseUrl,
  resolveCallbackToken,
  resolveTelegramWebhookSecret,
  selectMessagingProviders,
  selectPaymentProvider,
  TEST_CALLBACK_TOKEN,
  TEST_TELEGRAM_WEBHOOK_SECRET,
  type Dependencies,
} from "./bootstrap";
import { FakeMessagingAdapter } from "./infrastructure/messaging/fake-messaging.adapter";
import { FonnteWhatsAppAdapter } from "./infrastructure/messaging/fonnte-whatsapp.adapter";
import { TelegramBotAdapter } from "./infrastructure/messaging/telegram-bot.adapter";
import { createApp } from "./app";
import { FakePaymentAdapter } from "./infrastructure/payments/fake-payment.adapter";
import { XenditPaymentAdapter } from "./infrastructure/payments/xendit-payment.adapter";
import { RegisterCreator } from "./application/use-cases/register-creator";
import { AuthenticateCreator } from "./application/use-cases/authenticate-creator";
import { CreateCommunity } from "./application/use-cases/create-community";
import { ListCommunities } from "./application/use-cases/list-communities";
import { UpdateCommunity } from "./application/use-cases/update-community";
import {
  DefineMembershipTier,
  ListTiers,
  UpdateTier,
} from "./application/use-cases/manage-tiers";
import { ConnectChannel, ListChannels } from "./application/use-cases/manage-channels";
import { CreatePaymentAccount } from "./application/use-cases/create-payment-account";
import { GetPublicCommunity } from "./application/use-cases/get-public-community";
import { StartCheckout } from "./application/use-cases/start-checkout";
import { GetSubscriptionStatus } from "./application/use-cases/get-subscription-status";
import { HandlePaymentWebhook } from "./application/use-cases/handle-payment-webhook";
import { RevokeChannelAccess } from "./application/use-cases/revoke-channel-access";
import { RecordChannelJoin } from "./application/use-cases/record-channel-join";
import { SendRenewalReminder } from "./application/use-cases/send-renewal-reminder";
import { GetCommunityMetrics } from "./application/use-cases/get-community-metrics";
import { GetCommunityActivity } from "./application/use-cases/get-community-activity";
import { XENDIT_ACCOUNT_PROVISIONING } from "./domain/payment-account";
import type {
  CreatorRecord,
  CreatorRepositoryPort,
} from "./application/ports/creator-repository.port";
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
import type { PaymentActivationUnitOfWorkPort } from "./application/ports/payment-activation-unit-of-work.port";
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

const fakeSubscriptionRepository: SubscriptionRepositoryPort = {
  async createPending() {
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
};

const fakeOutboxRepository: OutboxRepositoryPort = {
  async enqueue() {
    return { id: "fake-outbox-1" };
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
      createCommunity: new CreateCommunity(fakeCommunityRepository),
      listCommunities: new ListCommunities(fakeCommunityRepository),
      updateCommunity: new UpdateCommunity(fakeCommunityRepository),
      defineTier: new DefineMembershipTier(fakeCommunityRepository, fakeMembershipTierRepository),
      listTiers: new ListTiers(fakeCommunityRepository, fakeMembershipTierRepository),
      updateTier: new UpdateTier(fakeCommunityRepository, fakeMembershipTierRepository),
      connectChannel: new ConnectChannel(fakeCommunityRepository, fakeChannelRepository),
      listChannels: new ListChannels(fakeCommunityRepository, fakeChannelRepository),
      createPaymentAccount: new CreatePaymentAccount(fakeCreatorRepository, fakePaymentProvider),
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
      getSubscriptionStatus: new GetSubscriptionStatus(fakeSubscriptionRepository),
      handlePaymentWebhook: new HandlePaymentWebhook(
        fakeSubscriptionRepository,
        fakePaymentActivationUnitOfWork,
        fakeClock
      ),
      getCommunityMetrics: new GetCommunityMetrics(fakeAnalyticsRepository),
      getCommunityActivity: new GetCommunityActivity(fakeAnalyticsRepository),
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
      createCommunity: new CreateCommunity(fakeCommunityRepository),
      listCommunities: new ListCommunities(fakeCommunityRepository),
      updateCommunity: new UpdateCommunity(fakeCommunityRepository),
      defineTier: new DefineMembershipTier(fakeCommunityRepository, fakeMembershipTierRepository),
      listTiers: new ListTiers(fakeCommunityRepository, fakeMembershipTierRepository),
      updateTier: new UpdateTier(fakeCommunityRepository, fakeMembershipTierRepository),
      connectChannel: new ConnectChannel(fakeCommunityRepository, fakeChannelRepository),
      listChannels: new ListChannels(fakeCommunityRepository, fakeChannelRepository),
      createPaymentAccount: new CreatePaymentAccount(fakeCreatorRepository, fakePaymentProvider),
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
      getSubscriptionStatus: new GetSubscriptionStatus(fakeSubscriptionRepository),
      handlePaymentWebhook: new HandlePaymentWebhook(
        fakeSubscriptionRepository,
        fakePaymentActivationUnitOfWork,
        fakeClock
      ),
      getCommunityMetrics: new GetCommunityMetrics(fakeAnalyticsRepository),
      getCommunityActivity: new GetCommunityActivity(fakeAnalyticsRepository),
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

  // CRITICAL, verified by probe before the fix: NODE_ENV=production with no
  // Xendit config returned a FakePaymentAdapter. POST /payment-account then
  // writes `fake-acct-1-<uuid>` into creator.xendit_account_id, and
  // CreatePaymentAccount 409s forever after — the creator can never connect a
  // real sub-account without manual SQL.
  it("refuses to start in production with no Xendit configuration", () => {
    expect(() =>
      selectPaymentProvider({
        secretKey: undefined,
        splitRuleId: undefined,
        nodeEnv: "production",
      })
    ).toThrow(/NODE_ENV is production/);
  });

  // CRITICAL, second pass. The `nodeEnv === "production"` denylist above was
  // never reachable on a real deployment: nothing in this repository sets
  // NODE_ENV (no `start` script, no Dockerfile, no API service in
  // infra/docker-compose.yml), so `bun -e 'console.log(process.env.NODE_ENV)'`
  // printed `undefined` and the guard silently returned FakePaymentAdapter.
  // The allowlist is what closes that: anything not explicitly relaxed throws.
  it("refuses to start for ANY nodeEnv outside the allowlist, including unset", () => {
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
      expect(() =>
        selectPaymentProvider({ secretKey: undefined, splitRuleId: undefined, nodeEnv })
      ).toThrow(/fake payment adapter is permitted ONLY/);
    }
  });

  it("says whether NODE_ENV was unset or merely unrecognised", () => {
    // An operator staring at "NODE_ENV is production" when they never set it
    // would look in the wrong place.
    expect(() =>
      selectPaymentProvider({ secretKey: undefined, splitRuleId: undefined, nodeEnv: undefined })
    ).toThrow(/NODE_ENV is not set/);
    expect(() =>
      selectPaymentProvider({ secretKey: undefined, splitRuleId: undefined, nodeEnv: "staging" })
    ).toThrow(/NODE_ENV is staging/);
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
    expect(() =>
      selectPaymentProvider({ secretKey: "", splitRuleId: "", nodeEnv: "production" })
    ).toThrow(/NODE_ENV is production/);
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

  it("refuses to boot a production process with no Xendit configuration", () => {
    // Reads NODE_ENV from the environment, so this pins the wiring too — not
    // just selectPaymentProvider in isolation.
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        {
          NODE_ENV: "production",
          XENDIT_SECRET_KEY: undefined,
          XENDIT_SPLIT_RULE_ID: undefined,
        },
        () => {
          expect(() => bootstrap()).toThrow(/NODE_ENV is production/);
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
  // guard. "staging" and an UNSET NODE_ENV used to boot happily with no
  // callback token, and an unset NODE_ENV is what a real deployment has,
  // because nothing in this repository sets it. Every delivery would then be
  // rejected: money taken, nobody activated, and no loud failure to say so.
  it("refuses to boot without a token for ANY nodeEnv outside the allowlist", () => {
    for (const nodeEnv of [
      undefined,
      "staging",
      "prod",
      "PRODUCTION",
      "Production",
      "dev",
      "",
    ]) {
      expect(() =>
        resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv })
      ).toThrow(/permitted ONLY when NODE_ENV is exactly/);
    }
  });

  it("distinguishes an unset NODE_ENV from an unrecognised one here too", () => {
    expect(() =>
      resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv: undefined })
    ).toThrow(/NODE_ENV is not set/);
    expect(() =>
      resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv: "staging" })
    ).toThrow(/NODE_ENV is staging/);
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

  it("refuses to start in production with no callback token", () => {
    expect(() =>
      resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv: "production" })
    ).toThrow(/NODE_ENV is production/);
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
    for (const blank of ["", "   ", "\t", "\n"]) {
      expect(() =>
        resolveCallbackToken({ callbackToken: blank, ...NO_XENDIT, nodeEnv: "production" })
      ).toThrow(/NODE_ENV is production/);
      expect(
        resolveCallbackToken({ callbackToken: blank, ...NO_XENDIT, nodeEnv: "test" })
      ).toBe(TEST_CALLBACK_TOKEN);
    }
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
    expect(() =>
      resolveCallbackToken({ callbackToken: undefined, ...NO_XENDIT, nodeEnv: "production" })
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
      withEnv(
        {
          NODE_ENV: "production",
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
        },
        () => {
          captureConsoleLog(() => {
            expect(() => bootstrap()).not.toThrow();
          });
        }
      );

      withEnv(
        {
          NODE_ENV: "production",
          XENDIT_SECRET_KEY: undefined,
          XENDIT_SPLIT_RULE_ID: undefined,
          XENDIT_CALLBACK_TOKEN: undefined,
        },
        () => {
          // selectPaymentProvider still speaks first here: with nothing
          // configured at all, "you are about to take fake money" is the more
          // urgent message, and this pins that ordering.
          expect(() => bootstrap()).toThrow(/NODE_ENV is production/);
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
    withJwtSecret("x".repeat(32), () => {
      withEnv(
        {
          NODE_ENV: "production",
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
