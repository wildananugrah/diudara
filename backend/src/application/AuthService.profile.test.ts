import { describe, expect, test } from "bun:test";
import { AuthService } from "./AuthService.ts";
import type { PasswordHasher, TokenIssuer, UserRepository } from "../domain/ports.ts";
import type { User } from "../domain/types.ts";
import { DomainError } from "../domain/errors.ts";

/** The status a rejection carries, which is what the client reacts to. */
async function statusOf(run: Promise<unknown>): Promise<number | undefined> {
  try {
    await run;
    return undefined;
  } catch (err) {
    return err instanceof DomainError ? err.status : -1;
  }
}

/**
 * An in-memory account store, so these tests exercise the real rules rather than
 * a mock's opinion of them. Two users exist: the one editing, and a neighbour
 * whose email and handle are already taken.
 */
function makeService() {
  const rows = new Map<string, User & { passwordHash: string }>([
    ["u1", {
      id: "u1", email: "rangga@diudara.id", name: "Rangga Putra", handle: "@rangga",
      avatarColor: "#2b4c6f", initials: "RP", passwordHash: "hash:password123",
    }],
    ["u2", {
      id: "u2", email: "sari@diudara.id", name: "Sari Wulandari", handle: "@sari",
      avatarColor: "#4c8b6e", initials: "SW", passwordHash: "hash:password123",
    }],
  ]);

  const strip = ({ passwordHash: _omit, ...user }: User & { passwordHash: string }): User => user;

  const users = {
    findById: async (id: string) => {
      const row = rows.get(id);
      return row ? strip(row) : null;
    },
    findByEmail: async (email: string) => {
      const row = [...rows.values()].find((r) => r.email === email.toLowerCase());
      return row ? { ...strip(row), passwordHash: row.passwordHash } : null;
    },
    findByIdWithPassword: async (id: string) => rows.get(id) ?? null,
    findByHandle: async (handle: string) => {
      const row = [...rows.values()].find((r) => r.handle === handle.toLowerCase());
      return row ? strip(row) : null;
    },
    update: async (id: string, patch: Partial<User & { passwordHash: string }>) => {
      const row = rows.get(id);
      if (!row) throw new Error(`no such user: ${id}`);
      const next = { ...row, ...patch };
      rows.set(id, next);
      return strip(next);
    },
  } as unknown as UserRepository;

  // Plain-text "hashing" so a test can assert what was stored. Real hashing is
  // BunPasswordHasher's job and is tested by using it, not by re-describing it.
  const hasher: PasswordHasher = {
    hash: async (plain) => `hash:${plain}`,
    verify: async (plain, hash) => hash === `hash:${plain}`,
  };
  const tokens = { sign: async () => "token", verify: async () => ({ sub: "u1" }) } as unknown as TokenIssuer;

  return { service: new AuthService(users, hasher, tokens), rows };
}

describe("updateProfile", () => {
  test("saves the name and recomputes the initials from it", async () => {
    // Initials are derived, never sent by the client: a client-supplied "ZZ" on a
    // user named Rangga would be a lie the avatar repeats everywhere.
    const { service } = makeService();
    const user = await service.updateProfile("u1", { name: "Wildan Anugrah" });
    expect(user.name).toBe("Wildan Anugrah");
    expect(user.initials).toBe("WA");
  });

  test("normalises a handle to a lowercase @name", async () => {
    const { service } = makeService();
    for (const [input, stored] of [["Wildan_9", "@wildan_9"], ["@BigName", "@bigname"]] as const) {
      const user = await service.updateProfile("u1", { handle: input });
      expect(user.handle).toBe(stored);
    }
  });

  test("refuses a handle shape that could not be one of ours", async () => {
    const { service } = makeService();
    for (const handle of ["ab", "a".repeat(21), "has space", "with-dash", "emoji🙂", "@"]) {
      await expect(service.updateProfile("u1", { handle })).rejects.toThrow(/handle/i);
    }
  });

  test("refuses a handle another account already holds", async () => {
    const { service } = makeService();
    await expect(service.updateProfile("u1", { handle: "sari" })).rejects.toThrow(/sudah/i);
  });

  test("lets a user re-save the handle they already have", async () => {
    // The uniqueness check must not treat the user's own row as a conflict.
    const { service } = makeService();
    const user = await service.updateProfile("u1", { handle: "@rangga", name: "Rangga P" });
    expect(user.handle).toBe("@rangga");
  });

  test("refuses an empty name", async () => {
    const { service } = makeService();
    await expect(service.updateProfile("u1", { name: "   " })).rejects.toThrow(/nama/i);
  });

  test("accepts only a colour from the app's palette", async () => {
    // The value is rendered as CSS on every avatar; a whitelist keeps anything
    // the client invents out of that position.
    const { service } = makeService();
    const ok = await service.updateProfile("u1", { avatarColor: "#e8873e" });
    expect(ok.avatarColor).toBe("#e8873e");
    for (const colour of ["#000000", "red", "url(evil)", "#e8873e; background:url(x)"]) {
      await expect(service.updateProfile("u1", { avatarColor: colour })).rejects.toThrow(/warna/i);
    }
  });

  test("touches nobody else's row", async () => {
    const { service, rows } = makeService();
    await service.updateProfile("u1", { name: "Berubah", handle: "berubah" });
    expect(rows.get("u2")).toMatchObject({ name: "Sari Wulandari", handle: "@sari" });
  });
});

describe("changeEmail", () => {
  test("changes the email once the current password checks out", async () => {
    const { service, rows } = makeService();
    const user = await service.changeEmail("u1", {
      currentPassword: "password123", email: "  NEW@Diudara.ID ",
    });
    expect(user.email).toBe("new@diudara.id");
    expect(rows.get("u1")!.email).toBe("new@diudara.id");
  });

  test("refuses a wrong current password, and changes nothing", async () => {
    const { service, rows } = makeService();
    await expect(service.changeEmail("u1", { currentPassword: "nope", email: "new@diudara.id" }))
      .rejects.toThrow(/kata sandi/i);
    expect(rows.get("u1")!.email).toBe("rangga@diudara.id");
  });

  test("refuses an email another account already holds", async () => {
    const { service } = makeService();
    await expect(service.changeEmail("u1", { currentPassword: "password123", email: "sari@diudara.id" }))
      .rejects.toThrow(/sudah/i);
  });

  test("refuses something that is not an email", async () => {
    const { service } = makeService();
    for (const email of ["nope", "a@b", "@diudara.id", "two @spaces.id"]) {
      await expect(service.changeEmail("u1", { currentPassword: "password123", email }))
        .rejects.toThrow(/email/i);
    }
  });
});

describe("changePassword", () => {
  test("stores a hash of the new password", async () => {
    const { service, rows } = makeService();
    await expect(service.changePassword("u1", {
      currentPassword: "password123", newPassword: "a-longer-secret",
    })).resolves.toEqual({ ok: true });
    expect(rows.get("u1")!.passwordHash).toBe("hash:a-longer-secret");
  });

  test("refuses a wrong current password, and changes nothing", async () => {
    const { service, rows } = makeService();
    await expect(service.changePassword("u1", { currentPassword: "nope", newPassword: "a-longer-secret" }))
      .rejects.toThrow(/kata sandi/i);
    expect(rows.get("u1")!.passwordHash).toBe("hash:password123");
  });

  test("holds the new password to the same minimum as registration", async () => {
    const { service } = makeService();
    await expect(service.changePassword("u1", { currentPassword: "password123", newPassword: "short" }))
      .rejects.toThrow(/8 karakter/);
  });
});

describe("a wrong current password is a form error, not a dead session", () => {
  // The client clears the stored token on ANY 401 — correct for an expired
  // session, ruinous here: mistyping the current password would silently sign
  // the user out mid-form, and the next save would fail as "Tidak
  // terautentikasi". Re-auth failure is a rejected field, so it must not be 401.
  test("changeEmail reports 422, not 401", async () => {
    const { service } = makeService();
    expect(await statusOf(service.changeEmail("u1", {
      currentPassword: "wrong", email: "new@diudara.id",
    }))).toBe(422);
  });

  test("changePassword reports 422, not 401", async () => {
    const { service } = makeService();
    expect(await statusOf(service.changePassword("u1", {
      currentPassword: "wrong", newPassword: "a-longer-secret",
    }))).toBe(422);
  });

  test("a genuinely missing account is still 401", async () => {
    // The distinction has to survive: no session is not the same as a typo.
    const { service } = makeService();
    expect(await statusOf(service.changePassword("ghost", {
      currentPassword: "password123", newPassword: "a-longer-secret",
    }))).toBe(401);
  });
});
