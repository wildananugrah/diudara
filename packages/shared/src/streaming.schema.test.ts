import { describe, expect, it } from "bun:test";
import { scheduleLiveSessionSchema } from "./streaming.schema";

describe("scheduleLiveSessionSchema", () => {
  it("accepts a title with an ISO scheduledAt", () => {
    const parsed = scheduleLiveSessionSchema.parse({
      title: "Live Q&A",
      scheduledAt: "2026-09-01T10:00:00.000Z",
    });
    expect(parsed.title).toBe("Live Q&A");
    expect(parsed.scheduledAt).toBeInstanceOf(Date);
    expect(parsed.scheduledAt!.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  it("accepts a title with no scheduledAt at all", () => {
    const parsed = scheduleLiveSessionSchema.parse({ title: "Go live now" });
    expect(parsed.scheduledAt).toBeUndefined();
  });

  it("trims whitespace from the title", () => {
    const parsed = scheduleLiveSessionSchema.parse({ title: "  Live Q&A  " });
    expect(parsed.title).toBe("Live Q&A");
  });

  it("rejects an empty title", () => {
    const result = scheduleLiveSessionSchema.safeParse({ title: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects a title longer than 255 characters", () => {
    const result = scheduleLiveSessionSchema.safeParse({ title: "a".repeat(256) });
    expect(result.success).toBe(false);
  });

  it("rejects a scheduledAt that cannot be parsed as a date", () => {
    const result = scheduleLiveSessionSchema.safeParse({
      title: "Live Q&A",
      scheduledAt: "not-a-date",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing title", () => {
    const result = scheduleLiveSessionSchema.safeParse({
      scheduledAt: "2026-09-01T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
