import type { PasswordHasher, TokenIssuer, UserRepository } from "../domain/ports.ts";
import type { User } from "../domain/types.ts";
import { ConflictError, UnauthorizedError, ValidationError } from "../domain/errors.ts";

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
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError("Format email tidak valid");
    if (input.password.length < 8) throw new ValidationError("Kata sandi minimal 8 karakter");
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
}
