import { describe, expect, it } from "bun:test";
import type { Dependencies } from "./bootstrap";
import { createApp } from "./app";
import { RegisterCreator } from "./application/use-cases/register-creator";
import { AuthenticateCreator } from "./application/use-cases/authenticate-creator";
import type {
  CreatorRecord,
  CreatorRepositoryPort,
} from "./application/ports/creator-repository.port";
import type { PasswordHasherPort } from "./application/ports/password-hasher.port";
import type { TokenIssuerPort } from "./application/ports/token-issuer.port";

/**
 * Guards dependency inversion: `Dependencies` must be typed against PORTS, not
 * against the concrete adapters. If it ever infers a concrete class again (e.g.
 * `ReturnType<typeof bootstrap>`), the object literals below stop type-checking
 * and `bun run typecheck` fails. No `as` casts are allowed in this file — a cast
 * would hide exactly the regression this test exists to catch.
 *
 * `registerCreator`/`authenticateCreator` are typed as the concrete use-case
 * classes (there's only one implementation of each, so no port exists for
 * them) — a class with private members can't be satisfied by a plain object
 * literal without a cast, so the fakes below construct real instances of
 * those classes wrapping hand-written fake ports instead.
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
    };

    const deps: Dependencies = {
      creatorRepository: fakeCreatorRepository,
      tokenIssuer: fakeTokenIssuer,
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
    };

    const deps: Dependencies = {
      creatorRepository: fakeCreatorRepository,
      tokenIssuer: fakeTokenIssuer,
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
      sql: async () => [{ one: 1 }],
    };

    const res = await createApp(deps).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
