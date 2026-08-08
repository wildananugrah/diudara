import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap, selectPaymentProvider, type Dependencies } from "./bootstrap";
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
import type {
  CreatorRecord,
  CreatorRepositoryPort,
} from "./application/ports/creator-repository.port";
import type { CommunityRepositoryPort } from "./application/ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "./application/ports/membership-tier-repository.port";
import type { ChannelRepositoryPort } from "./application/ports/channel-repository.port";
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
 * `listChannels`/`createPaymentAccount`/`getPublicCommunity` are typed as the
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
      async setXenditAccountId(id, accountId) {
        const record = stored.find((r) => r.id === id);
        if (record) record.xenditAccountId = accountId;
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
      async setXenditAccountId() {
        // not used
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
    let provider: unknown;
    const logs = captureConsoleLog(() => {
      provider = selectPaymentProvider({
        secretKey: "sk_live_x",
        splitRuleId: "splitrule_1",
      });
    });

    expect(provider).toBeInstanceOf(XenditPaymentAdapter);
    expect(logs.some((line) => /XenditPaymentAdapter/.test(line))).toBe(true);
  });

  it("selects FakePaymentAdapter when both env vars are unset", () => {
    let provider: unknown;
    const logs = captureConsoleLog(() => {
      provider = selectPaymentProvider({ secretKey: undefined, splitRuleId: undefined });
    });

    expect(provider).toBeInstanceOf(FakePaymentAdapter);
    expect(logs.some((line) => /FakePaymentAdapter/.test(line))).toBe(true);
  });

  it("selects FakePaymentAdapter when only the secret key is set", () => {
    const provider = selectPaymentProvider({
      secretKey: "sk_live_x",
      splitRuleId: undefined,
    });
    expect(provider).toBeInstanceOf(FakePaymentAdapter);
  });

  it("selects FakePaymentAdapter when only the split rule id is set", () => {
    const provider = selectPaymentProvider({
      secretKey: undefined,
      splitRuleId: "splitrule_1",
    });
    expect(provider).toBeInstanceOf(FakePaymentAdapter);
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
});
