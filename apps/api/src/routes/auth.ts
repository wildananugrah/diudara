import { Hono } from "hono";
import { loginSchema, signupSchema, type LoginInput, type SignupInput } from "@diudara/shared";
import { validate } from "../http/validate";
import type { AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

export function authRoutes(
  deps: Pick<Dependencies, "registerCreator" | "authenticateCreator">
) {
  return new Hono<{ Variables: AuthVariables }>()
    .post("/signup", validate(signupSchema), async (c) => {
      const input = c.get("validated") as SignupInput;
      const result = await deps.registerCreator.execute(input);
      return c.json(result, 201);
    })
    .post("/login", validate(loginSchema), async (c) => {
      const input = c.get("validated") as LoginInput;
      const result = await deps.authenticateCreator.execute(input);
      return c.json(result, 200);
    });
}
