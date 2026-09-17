import { expect, test } from "bun:test";
import { JwtTokenIssuer } from "./JwtTokenIssuer.ts";

const issuer = new JwtTokenIssuer("test_secret_value", "1h");

test("round-trips a subject", async () => {
  const token = await issuer.sign({ sub: "user-123" });
  expect(await issuer.verify(token)).toEqual({ sub: "user-123" });
});

test("rejects a token signed with a different secret", async () => {
  const forged = await new JwtTokenIssuer("attacker_secret", "1h").sign({ sub: "user-123" });
  expect(await issuer.verify(forged)).toBeNull();
});

test("rejects a tampered payload", async () => {
  const token = await issuer.sign({ sub: "user-123" });
  const [header, , signature] = token.split(".") as [string, string, string];
  const swapped = btoa(JSON.stringify({ sub: "admin", exp: 9999999999 }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(await issuer.verify(`${header}.${swapped}.${signature}`)).toBeNull();
});

test("rejects an expired token", async () => {
  const expired = new JwtTokenIssuer("test_secret_value", "1s");
  const token = await expired.sign({ sub: "user-123" });
  await Bun.sleep(1100);
  expect(await expired.verify(token)).toBeNull();
});

test("rejects malformed input rather than throwing", async () => {
  for (const bad of ["", "not-a-jwt", "a.b", "a.b.c.d", "...", "a.!!!.c"]) {
    expect(await issuer.verify(bad)).toBeNull();
  }
});

test("'none' algorithm is not accepted", async () => {
  const enc = (o: unknown) => btoa(JSON.stringify(o))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const noneToken = `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub: "admin", exp: 9999999999 })}.`;
  expect(await issuer.verify(noneToken)).toBeNull();
});
