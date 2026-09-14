import { describe, expect, it } from "bun:test";
import { coBuilderChatRequestSchema, coBuilderMessageSchema } from "./co-builder.schema";

describe("coBuilderMessageSchema", () => {
  it("accepts a user or assistant message", () => {
    expect(coBuilderMessageSchema.safeParse({ role: "user", content: "Halo" }).success).toBe(true);
    expect(coBuilderMessageSchema.safeParse({ role: "assistant", content: "Halo" }).success).toBe(true);
  });

  it("rejects any other role, including system — the client never injects that itself", () => {
    const result = coBuilderMessageSchema.safeParse({ role: "system", content: "Halo" });
    expect(result.success).toBe(false);
  });

  it("rejects empty content", () => {
    const result = coBuilderMessageSchema.safeParse({ role: "user", content: "" });
    expect(result.success).toBe(false);
  });

  it("rejects content past 2000 characters", () => {
    const result = coBuilderMessageSchema.safeParse({ role: "user", content: "a".repeat(2001) });
    expect(result.success).toBe(false);
  });

  it("trims content", () => {
    const parsed = coBuilderMessageSchema.parse({ role: "user", content: "  Halo  " });
    expect(parsed.content).toBe("Halo");
  });
});

describe("coBuilderChatRequestSchema", () => {
  it("accepts a single message", () => {
    const result = coBuilderChatRequestSchema.safeParse({
      messages: [{ role: "user", content: "Halo" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty messages array", () => {
    const result = coBuilderChatRequestSchema.safeParse({ messages: [] });
    expect(result.success).toBe(false);
  });

  it("rejects more than 30 messages", () => {
    const messages = Array.from({ length: 31 }, () => ({ role: "user" as const, content: "a" }));
    const result = coBuilderChatRequestSchema.safeParse({ messages });
    expect(result.success).toBe(false);
  });

  it("accepts exactly 30 messages", () => {
    const messages = Array.from({ length: 30 }, () => ({ role: "user" as const, content: "a" }));
    const result = coBuilderChatRequestSchema.safeParse({ messages });
    expect(result.success).toBe(true);
  });
});
