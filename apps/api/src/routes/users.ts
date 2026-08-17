import { Hono } from "hono";
import {
  updateProfileSchema,
  userLoginSchema,
  userSignupSchema,
  type UpdateProfileInput,
  type UserLoginInput,
  type UserSignupInput,
} from "@diudara/shared";
import { validate } from "../http/validate";
import { requireUserAuth, type UserAuthVariables } from "../http/user-auth.middleware";
import type { Dependencies } from "../bootstrap";

/**
 * `POST /users/signup` and `POST /users/login` — a personal account, distinct
 * from creator auth mounted at `/auth`. Neither route is behind
 * `requireUserAuth`: signup has no session yet, and login is how one is
 * obtained.
 *
 * `GET /users/by-handle/:handle` is ALSO public — anyone can browse a
 * profile without authenticating, by design (spec §3.2) — but
 * `GET /users/me` and `PATCH /users/me` are behind `requireUserAuth`, applied
 * per-route rather than via `app.use("*", ...)` so it never accidentally
 * guards signup/login/by-handle too (the same reason `routes/analytics.ts`
 * mounts `requireAuth` per-route instead of on `"*"`).
 */
export function userRoutes(
  deps: Pick<
    Dependencies,
    | "registerUser"
    | "authenticateUser"
    | "userTokenIssuer"
    | "userRepository"
    | "getUserProfile"
    | "updateUserProfile"
  >
) {
  const app = new Hono<{ Variables: UserAuthVariables }>();
  const requireAuth = requireUserAuth(deps.userTokenIssuer, deps.userRepository);

  app.post("/signup", validate(userSignupSchema), async (c) => {
    const input = c.get("validated") as UserSignupInput;
    // `{ ok: true }` only — see `RegisterUser`'s own docstring for why a
    // duplicate email must return exactly this and nothing more.
    const result = await deps.registerUser.execute(input);
    return c.json(result, 201);
  });

  app.post("/login", validate(userLoginSchema), async (c) => {
    const input = c.get("validated") as UserLoginInput;
    const result = await deps.authenticateUser.execute(input);
    return c.json(result, 200);
  });

  // Public. Bare handle — the `@` is a web URL convention only; encoding it
  // into every caller/log line is the cost of putting it in the API path
  // instead. `normalizeHandle` (inside `GetUserProfile`) strips one leading
  // `@` if a client sends it anyway, so a mistake here is forgiving rather
  // than a 404.
  app.get<"/by-handle/:handle">("/by-handle/:handle", async (c) => {
    const profile = await deps.getUserProfile.execute(c.req.param("handle"));
    return c.json(profile);
  });

  app.get<"/me">("/me", requireAuth, async (c) => {
    const profile = await deps.getUserProfile.executeOwn(c.get("userId"));
    return c.json(profile);
  });

  app.patch<"/me">("/me", requireAuth, validate(updateProfileSchema), async (c) => {
    const patch = c.get("validated") as UpdateProfileInput;
    const updated = await deps.updateUserProfile.execute({ userId: c.get("userId"), patch });
    return c.json(updated);
  });

  return app;
}
