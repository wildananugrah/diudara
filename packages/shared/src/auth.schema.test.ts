import { describe, expect, it } from "bun:test";
import { signupSchema, loginSchema, updateProfileSchema } from "./auth.schema";

describe("signupSchema", () => {
  it("accepts a valid signup and lowercases the email", () => {
    const parsed = signupSchema.parse({
      name: "Budi",
      email: "Budi@Example.COM",
      password: "supersecret123",
    });
    expect(parsed.email).toBe("budi@example.com");
    expect(parsed.name).toBe("Budi");
  });

  it("rejects a password shorter than 8 characters", () => {
    const result = signupSchema.safeParse({
      name: "Budi",
      email: "budi@example.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed email", () => {
    const result = signupSchema.safeParse({
      name: "Budi",
      email: "not-an-email",
      password: "supersecret123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty name", () => {
    const result = signupSchema.safeParse({
      name: "   ",
      email: "budi@example.com",
      password: "supersecret123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an email longer than 255 characters", () => {
    const longEmail = "a".repeat(250) + "@example.com";
    const result = signupSchema.safeParse({
      name: "Budi",
      email: longEmail,
      password: "supersecret123",
    });
    expect(result.success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("accepts valid credentials and lowercases the email", () => {
    const parsed = loginSchema.parse({ email: "BUDI@example.com", password: "whatever1" });
    expect(parsed.email).toBe("budi@example.com");
  });
});

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
