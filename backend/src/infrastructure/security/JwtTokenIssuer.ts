import type { TokenIssuer } from "../../domain/ports.ts";

const b64url = {
  encode: (data: Uint8Array | string): string => {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode: (s: string): string => {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
    return atob(padded);
  },
};

function parseDuration(spec: string): number {
  const m = /^(\d+)([smhd])$/.exec(spec);
  if (!m) throw new Error(`Invalid JWT_EXPIRES_IN: ${spec}`);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * mult;
}

/** HS256 JWT via WebCrypto — no jsonwebtoken dependency needed. */
export class JwtTokenIssuer implements TokenIssuer {
  private readonly ttlSeconds: number;
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private readonly secret: string, expiresIn: string) {
    this.ttlSeconds = parseDuration(expiresIn);
  }

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return this.keyPromise;
  }

  private async signature(data: string): Promise<string> {
    const sig = await crypto.subtle.sign("HMAC", await this.key(), new TextEncoder().encode(data));
    return b64url.encode(new Uint8Array(sig));
  }

  async sign(payload: { sub: string }): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = b64url.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url.encode(JSON.stringify({ ...payload, iat: nowSec, exp: nowSec + this.ttlSeconds }));
    const data = `${header}.${body}`;
    return `${data}.${await this.signature(data)}`;
  }

  async verify(token: string): Promise<{ sub: string } | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts as [string, string, string];

    const expected = await this.signature(`${header}.${body}`);
    // Constant-time-ish: compare full strings of equal length only.
    if (sig.length !== expected.length) return null;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff !== 0) return null;

    try {
      const claims = JSON.parse(b64url.decode(body)) as { sub?: string; exp?: number };
      if (!claims.sub || typeof claims.exp !== "number") return null;
      // RFC 7519: a token is valid only while now < exp, so expiry is `exp <= now`.
      // Using `<` here would keep a token usable for up to one extra second.
      if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
      return { sub: claims.sub };
    } catch {
      return null;
    }
  }
}
