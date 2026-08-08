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

  it("selects FakePaymentAdapter when both env vars are unset outside production", () => {
    captureConsoleLog(() => {
      for (const nodeEnv of ["test", "development", undefined]) {
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
