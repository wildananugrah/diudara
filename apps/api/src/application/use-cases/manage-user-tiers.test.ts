import { describe, expect, it } from "bun:test";
import { ManageUserTiers } from "./manage-user-tiers";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { UserTierRepositoryPort, UserTierRow } from "../ports/user-tier-repository.port";
import type {
  UserPayoutAccount,
  UserPayoutRepositoryPort,
} from "../ports/user-payout-repository.port";

/**
 * The sentinel as a LITERAL, never the imported constant — a test that
 * compares the code against itself would still pass if the value changed
 * under it. Mirrors `connect-user-payout.test.ts`'s own `SENTINEL`.
 */
const SENTINEL = "provisioning:in-progress";

/** In-memory `UserTierRepositoryPort`. */
function fakeTierRepository(seed: UserTierRow[] = []) {
  const rows = seed.map((row) => ({ ...row }));
  let counter = 0;
  const repository: UserTierRepositoryPort = {
    async create(input) {
      counter += 1;
      const row: UserTierRow = {
        id: `tier-${counter}`,
        ownerId: input.ownerId,
        name: input.name,
        priceAmount: input.priceAmount,
        billingCycle: input.billingCycle,
        isActive: true,
        createdAt: new Date("2026-08-20T00:00:00Z"),
      };
      rows.push(row);
      return { ...row };
    },
    async findById(id) {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async listByOwner(ownerId) {
      return rows.filter((r) => r.ownerId === ownerId).map((r) => ({ ...r }));
    },
    async listActiveByOwner(ownerId) {
      return rows.filter((r) => r.ownerId === ownerId && r.isActive).map((r) => ({ ...r }));
    },
    async deactivate(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      row.isActive = false;
      return { ...row };
    },
  };
  return { repository, rows };
}

/**
 * In-memory `UserPayoutRepositoryPort`. `ManageUserTiers` only ever calls
 * `findPayoutAccount` — the three provisioning methods exist purely to
 * satisfy the interface and throw if `create` ever starts calling them,
 * which would mean this use case had started provisioning payouts itself
 * rather than only reading their state.
 */
function fakePayoutRepository(seed: UserPayoutAccount[] = []) {
  const rows = seed.map((row) => ({ ...row }));
  const repository: UserPayoutRepositoryPort = {
    async findPayoutAccount(id) {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async beginXenditAccountProvisioning() {
      throw new Error("ManageUserTiers must never provision a payout account itself");
    },
    async finishXenditAccountProvisioning() {
      throw new Error("ManageUserTiers must never provision a payout account itself");
    },
    async abandonXenditAccountProvisioning() {
      throw new Error("ManageUserTiers must never provision a payout account itself");
    },
  };
  return { repository, rows };
}

function payoutUser(overrides: Partial<UserPayoutAccount> = {}): UserPayoutAccount {
  return {
    id: "owner-1",
    email: "wildan@example.com",
    displayName: "Wildan",
    xenditAccountId: null,
    ...overrides,
  };
}

function connectedPayoutUser(overrides: Partial<UserPayoutAccount> = {}): UserPayoutAccount {
  return payoutUser({ xenditAccountId: "xnd-acct-real", ...overrides });
}

describe("ManageUserTiers.create", () => {
  it("creates a tier for an owner with a connected payout account", async () => {
    const { repository: tiers } = fakeTierRepository();
    const { repository: payouts } = fakePayoutRepository([connectedPayoutUser()]);

    const tier = await new ManageUserTiers(tiers, payouts).create({
      ownerId: "owner-1",
      name: "Anggota",
      priceAmount: 50_000,
    });

    expect(tier).toMatchObject({
      ownerId: "owner-1",
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
      isActive: true,
    });
  });

  it("REFUSES to create a tier when the owner has no payout account, in Bahasa naming the remedy", async () => {
    const { repository: tiers, rows: tierRows } = fakeTierRepository();
    const { repository: payouts } = fakePayoutRepository([payoutUser({ xenditAccountId: null })]);

    const error = await new ManageUserTiers(tiers, payouts)
      .create({ ownerId: "owner-1", name: "Anggota", priceAmount: 50_000 })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toBe(
      "Hubungkan akun pembayaran Anda terlebih dahulu sebelum menerbitkan tingkatan " +
        "keanggotaan — uang dari tingkatan ini belum punya tempat tujuan."
    );
    // Nothing was created.
    expect(tierRows).toEqual([]);
  });

  it("THE SENTINEL DOES NOT COUNT AS CONNECTED: a mid-provisioning owner is refused too", async () => {
    // `if (owner.xenditAccountId)` is TRUE for the sentinel — it is a
    // non-empty string. A truthiness check here would let a half-provisioned,
    // KYC-pending connection publish a tier that Task 6 would then send to
    // Xendit as `for_account_id: "provisioning:in-progress"`.
    const { repository: tiers, rows: tierRows } = fakeTierRepository();
    const { repository: payouts } = fakePayoutRepository([
      payoutUser({ xenditAccountId: SENTINEL }),
    ]);

    const error = await new ManageUserTiers(tiers, payouts)
      .create({ ownerId: "owner-1", name: "Anggota", priceAmount: 50_000 })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConflictError);
    expect(tierRows).toEqual([]);
  });

  it("REFUSES a non-positive price, in Bahasa", async () => {
    const { repository: tiers, rows: tierRows } = fakeTierRepository();
    const { repository: payouts } = fakePayoutRepository([connectedPayoutUser()]);
    const useCase = new ManageUserTiers(tiers, payouts);

    for (const priceAmount of [0, -1, -50_000]) {
      const error = await useCase
        .create({ ownerId: "owner-1", name: "Anggota", priceAmount })
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toBe("Harga tingkatan harus lebih dari nol.");
    }
    expect(tierRows).toEqual([]);
  });

  it("refuses a non-integer price", async () => {
    const { repository: tiers, rows: tierRows } = fakeTierRepository();
    const { repository: payouts } = fakePayoutRepository([connectedPayoutUser()]);

    const error = await new ManageUserTiers(tiers, payouts)
      .create({ ownerId: "owner-1", name: "Anggota", priceAmount: 49_999.5 })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ValidationError);
    expect(tierRows).toEqual([]);
  });

  it("refuses an empty (or whitespace-only) name", async () => {
    const { repository: tiers } = fakeTierRepository();
    const { repository: payouts } = fakePayoutRepository([connectedPayoutUser()]);
    const useCase = new ManageUserTiers(tiers, payouts);

    for (const name of ["", "   "]) {
      const error = await useCase
        .create({ ownerId: "owner-1", name, priceAmount: 50_000 })
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toBe("Nama tingkatan tidak boleh kosong.");
    }
  });

  it("refuses a billing cycle other than monthly — the only one 5a supports", async () => {
    const { repository: tiers } = fakeTierRepository();
    const { repository: payouts } = fakePayoutRepository([connectedPayoutUser()]);

    const error = await new ManageUserTiers(tiers, payouts)
      .create({ ownerId: "owner-1", name: "Anggota", priceAmount: 50_000, billingCycle: "yearly" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ValidationError);
  });

  it("defaults billingCycle to the literal 'monthly' when omitted", async () => {
    const { repository: tiers } = fakeTierRepository();
    const { repository: payouts } = fakePayoutRepository([connectedPayoutUser()]);

    const tier = await new ManageUserTiers(tiers, payouts).create({
      ownerId: "owner-1",
      name: "Anggota",
      priceAmount: 50_000,
    });

    expect(tier.billingCycle).toBe("monthly");
  });
});

describe("ManageUserTiers.list", () => {
  it("returns every tier this owner has defined, active and inactive alike", async () => {
    const { repository: tiers } = fakeTierRepository([
      {
        id: "tier-1",
        ownerId: "owner-1",
        name: "Anggota",
        priceAmount: 50_000,
        billingCycle: "monthly",
        isActive: true,
        createdAt: new Date(),
      },
      {
        id: "tier-2",
        ownerId: "owner-1",
        name: "VIP (lama)",
        priceAmount: 100_000,
        billingCycle: "monthly",
        isActive: false,
        createdAt: new Date(),
      },
      {
        id: "tier-3",
        ownerId: "owner-2",
        name: "Bukan milik saya",
        priceAmount: 10_000,
        billingCycle: "monthly",
        isActive: true,
        createdAt: new Date(),
      },
    ]);
    const { repository: payouts } = fakePayoutRepository();

    const result = await new ManageUserTiers(tiers, payouts).list("owner-1");

    expect(result.map((t) => t.id).sort()).toEqual(["tier-1", "tier-2"]);
  });
});

describe("ManageUserTiers.deactivate", () => {
  function seeded() {
    return fakeTierRepository([
      {
        id: "tier-1",
        ownerId: "owner-1",
        name: "Anggota",
        priceAmount: 50_000,
        billingCycle: "monthly",
        isActive: true,
        createdAt: new Date(),
      },
    ]);
  }

  it("flips isActive to false and returns the updated row", async () => {
    const { repository: tiers } = seeded();
    const { repository: payouts } = fakePayoutRepository();

    const updated = await new ManageUserTiers(tiers, payouts).deactivate({
      ownerId: "owner-1",
      tierId: "tier-1",
    });

    expect(updated.isActive).toBe(false);
  });

  it("does not delete the row and does not touch any subscription port — deactivate calls only the tier repository", async () => {
    const { repository: tiers, rows } = seeded();
    const { repository: payouts } = fakePayoutRepository();

    await new ManageUserTiers(tiers, payouts).deactivate({ ownerId: "owner-1", tierId: "tier-1" });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("tier-1");
  });

  it("REFUSES with NotFoundError when the tier belongs to a DIFFERENT owner — one owner cannot edit another's tier", async () => {
    const { repository: tiers, rows } = seeded();
    const { repository: payouts } = fakePayoutRepository();

    const error = await new ManageUserTiers(tiers, payouts)
      .deactivate({ ownerId: "someone-else", tierId: "tier-1" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe("tier not found");
    // Untouched — the stranger's attempt did not deactivate it.
    expect(rows[0].isActive).toBe(true);
  });

  it("404s a tier id that does not exist at all", async () => {
    const { repository: tiers } = fakeTierRepository();
    const { repository: payouts } = fakePayoutRepository();

    const error = await new ManageUserTiers(tiers, payouts)
      .deactivate({ ownerId: "owner-1", tierId: "no-such-tier" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe("tier not found");
  });
});
