import type { Hono } from "hono";

let counter = 0;

/** Signs up a fresh creator and returns their bearer token and id. */
export async function signupAndGetToken(
  app: Hono<any>,
  overrides: { name?: string; email?: string; password?: string } = {}
): Promise<{ token: string; creatorId: string; email: string }> {
  counter += 1;
  const email = overrides.email ?? `creator${counter}-${Date.now()}@example.com`;
  const res = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: overrides.name ?? `Creator ${counter}`,
      email,
      password: overrides.password ?? "supersecret123",
    }),
  });

  if (res.status !== 201) {
    throw new Error(`signup failed in test setup: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  return { token: body.token, creatorId: body.creator.id, email };
}

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
