import { Hono } from "hono";
import {
  userLoginSchema,
  userSignupSchema,
  type UserLoginInput,
  type UserSignupInput,
} from "@diudara/shared";
import { validate } from "../http/validate";
import type { UserAuthVariables } from "../http/user-auth.middleware";
import type { Dependencies } from "../bootstrap";

/**
 * `POST /users/signup` and `POST /users/login` — a personal account, distinct
 * from creator auth mounted at `/auth`. Neither route is behind
 * `requireUserAuth`: signup has no session yet, and login is how one is
 * obtained.
 */
export function userRoutes(deps: Pick<Dependencies, "registerUser" | "authenticateUser">) {
  return new Hono<{ Variables: UserAuthVariables }>()
    .post("/signup", validate(userSignupSchema), async (c) => {
      const input = c.get("validated") as UserSignupInput;
      // `{ ok: true }` only — see `RegisterUser`'s own docstring for why a
      // duplicate email must return exactly this and nothing more.
      const result = await deps.registerUser.execute(input);
      return c.json(result, 201);
    })
    .post("/login", validate(userLoginSchema), async (c) => {
      const input = c.get("validated") as UserLoginInput;
      const result = await deps.authenticateUser.execute(input);
      return c.json(result, 200);
    });
}
