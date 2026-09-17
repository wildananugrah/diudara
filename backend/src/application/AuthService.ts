import type { PasswordHasher, TokenIssuer, UserRepository } from "../domain/ports.ts";
import type { User } from "../domain/types.ts";
import { ConflictError, UnauthorizedError, ValidationError } from "../domain/errors.ts";

/** The whole email rule, in one place, so register and changeEmail cannot drift. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Stored with a leading `@`; this matches what follows it. */
const HANDLE = /^[a-z0-9_]{3,20}$/;
const MIN_PASSWORD = 8;

const PALETTE = ["#93A8C2", "#2b4c6f", "#e8873e", "#4c8b6e", "#c1543d", "#3e6690"];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "";
  return (first + last).toUpperCase();
}

function handleOf(name: string, salt: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "user";
  return `@${base}${salt}`;
}

export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenIssuer,
  ) {}

  async register(input: { email: string; password: string; name: string }): Promise<{ user: User; token: string }> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email)) throw new ValidationError("Format email tidak valid");
    if (input.password.length < MIN_PASSWORD) throw new ValidationError("Kata sandi minimal 8 karakter");
    if (!input.name.trim()) throw new ValidationError("Nama wajib diisi");

    if (await this.users.findByEmail(email)) throw new ConflictError("Email sudah terdaftar");

    const name = input.name.trim();
    const user = await this.users.create({
      email,
      passwordHash: await this.hasher.hash(input.password),
      name,
      handle: handleOf(name, Math.random().toString(36).slice(2, 6)),
      avatarColor: PALETTE[Math.floor(Math.random() * PALETTE.length)]!,
      initials: initialsOf(name),
    });

    return { user, token: await this.tokens.sign({ sub: user.id }) };
  }

  async login(input: { email: string; password: string }): Promise<{ user: User; token: string }> {
    const record = await this.users.findByEmail(input.email.trim().toLowerCase());

    // Same message and (roughly) the same work whether the email exists or the
    // password is wrong, so this endpoint cannot be used to enumerate accounts.
    if (!record) {
      await this.hasher.hash(input.password);
      throw new UnauthorizedError("Email atau kata sandi salah");
    }
    if (!(await this.hasher.verify(input.password, record.passwordHash))) {
      throw new UnauthorizedError("Email atau kata sandi salah");
    }

    const { passwordHash: _omit, ...user } = record;
    return { user, token: await this.tokens.sign({ sub: user.id }) };
  }

  async me(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedError();
    return user;
  }

  /**
   * The parts of an account a signed-in user may change freely.
   *
   * Every field is optional and only what arrives is touched, so the page can
   * save one card without sending — or silently resetting — the others. The user
   * id comes from the token; nothing here reads an id from the request body.
   */
  async updateProfile(
    userId: string,
    patch: { name?: string; handle?: string; avatarColor?: string },
  ): Promise<User> {
    const update: { name?: string; initials?: string; handle?: string; avatarColor?: string } = {};

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ValidationError("Nama wajib diisi");
      if (name.length > 60) throw new ValidationError("Nama maksimal 60 karakter");
      update.name = name;
      // Derived, never client-supplied: the avatar shows these initials on every
      // post and comment, so they must agree with the name beside them.
      update.initials = initialsOf(name);
    }

    if (patch.handle !== undefined) {
      const handle = patch.handle.trim().toLowerCase().replace(/^@/, "");
      if (!HANDLE.test(handle)) {
        throw new ValidationError("Handle hanya boleh huruf kecil, angka dan _, 3–20 karakter");
      }
      const taken = await this.users.findByHandle(`@${handle}`);
      // Re-saving your own handle is not a conflict — the profile form sends every
      // field in its card, including the ones that did not change.
      if (taken && taken.id !== userId) throw new ConflictError("Handle sudah dipakai akun lain");
      update.handle = `@${handle}`;
    }

    if (patch.avatarColor !== undefined) {
      // A whitelist, because this value is rendered as CSS on every avatar.
      if (!PALETTE.includes(patch.avatarColor)) throw new ValidationError("Warna avatar tidak dikenali");
      update.avatarColor = patch.avatarColor;
    }

    if (Object.keys(update).length === 0) return this.me(userId);
    return this.users.update(userId, update);
  }

  /**
   * Changing the address an account is recovered by is a takeover vector, so it
   * costs the current password — the session alone is not enough.
   *
   * There is no mail infrastructure in this project, so the new address is live
   * immediately and unverified. The UI says so rather than implying a
   * confirmation step that does not exist.
   */
  async changeEmail(userId: string, input: { currentPassword: string; email: string }): Promise<User> {
    await this.confirmPassword(userId, input.currentPassword);

    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email)) throw new ValidationError("Format email tidak valid");

    const taken = await this.users.findByEmail(email);
    if (taken && taken.id !== userId) throw new ConflictError("Email sudah terdaftar di akun lain");

    return this.users.update(userId, { email });
  }

  /**
   * Existing tokens carry only `sub`, so they stay valid after this: changing the
   * password does NOT sign other sessions out. Said plainly on the page, because
   * the opposite is what people assume.
   */
  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<{ ok: true }> {
    await this.confirmPassword(userId, input.currentPassword);
    if (input.newPassword.length < MIN_PASSWORD) {
      throw new ValidationError("Kata sandi minimal 8 karakter");
    }
    await this.users.update(userId, { passwordHash: await this.hasher.hash(input.newPassword) });
    return { ok: true };
  }

  /**
   * Re-authentication for the two changes that can lose someone their account.
   *
   * A wrong password here is a ValidationError, NOT an UnauthorizedError, and the
   * difference is load-bearing: the client clears its stored token on any 401
   * (right for an expired session), so returning 401 for a typo signed the user
   * out mid-form and made their next save fail as "Tidak terautentikasi". The
   * session is fine; one submitted field is wrong. A genuinely missing account is
   * still 401, because then there really is no session.
   */
  private async confirmPassword(userId: string, currentPassword: string): Promise<void> {
    const record = await this.users.findByIdWithPassword(userId);
    if (!record) throw new UnauthorizedError();
    if (!(await this.hasher.verify(currentPassword ?? "", record.passwordHash))) {
      throw new ValidationError("Kata sandi saat ini salah");
    }
  }
}
