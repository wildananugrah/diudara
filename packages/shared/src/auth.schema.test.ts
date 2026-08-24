import { describe, expect, it } from "bun:test";
import { updateProfileSchema } from "./auth.schema";

/*
 * The `signupSchema` and `loginSchema` blocks that opened this file went
 * with the schemas themselves in retire-telegram Task 7's fix round — they
 * were the creator-only pair behind `POST /auth/signup` and
 * `POST /auth/login`, and nothing calls either route any more. The user
 * equivalents (`userSignupSchema`, `userLoginSchema`) are exercised through
 * the routes that use them, in `apps/api/src/routes/users.test.ts`.
 */
describe("updateProfileSchema — whatsappNumber", () => {
  it("accepts a tolerant Indonesian number, matching userSignupSchema's own regex", () => {
    const parsed = updateProfileSchema.parse({ whatsappNumber: "081234567890" });
    expect(parsed.whatsappNumber).toBe("081234567890");
  });

  it("accepts an explicit null, to clear the number", () => {
    const parsed = updateProfileSchema.parse({ whatsappNumber: null });
    expect(parsed.whatsappNumber).toBeNull();
  });

  it("an absent whatsappNumber does not appear in the parsed patch at all", () => {
    const parsed = updateProfileSchema.parse({ displayName: "Wildan" });
    expect("whatsappNumber" in parsed).toBe(false);
  });

  it("rejects a malformed number", () => {
    const result = updateProfileSchema.safeParse({ whatsappNumber: "not-a-number" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty string — unlike bio, this is not silently normalised to null", () => {
    const result = updateProfileSchema.safeParse({ whatsappNumber: "" });
    expect(result.success).toBe(false);
  });
});
