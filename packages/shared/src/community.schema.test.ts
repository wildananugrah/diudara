import { describe, expect, it } from "bun:test";
import {
  createCommunitySchema,
  updateCommunitySchema,
  createTierSchema,
  updateTierSchema,
  connectChannelSchema,
} from "./community.schema";

describe("createCommunitySchema", () => {
  it("accepts a valid community creation", () => {
    const parsed = createCommunitySchema.parse({
      name: "Tech Community",
      niche: "Technology",
    });
    expect(parsed.name).toBe("Tech Community");
    expect(parsed.niche).toBe("Technology");
  });

  it("accepts a community with non-ASCII characters and punctuation", () => {
    const parsed = createCommunitySchema.parse({
      name: "Komunitas Peternak Lelé & Nila (Jawa Timur)",
      niche: "Pertanian",
    });
    expect(parsed.name).toBe("Komunitas Peternak Lelé & Nila (Jawa Timur)");
  });

  it("trims whitespace from name", () => {
    const parsed = createCommunitySchema.parse({
      name: "  Community  ",
    });
    expect(parsed.name).toBe("Community");
  });

  it("accepts community without niche", () => {
    const parsed = createCommunitySchema.parse({
      name: "Just a Community",
    });
    expect(parsed.niche).toBeUndefined();
  });

  it("rejects empty name", () => {
    const result = createCommunitySchema.safeParse({
      name: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects niche longer than 128 characters", () => {
    const result = createCommunitySchema.safeParse({
      name: "Community",
      niche: "a".repeat(129),
    });
    expect(result.success).toBe(false);
  });
});

describe("updateCommunitySchema", () => {
  it("accepts valid update with name only", () => {
    const parsed = updateCommunitySchema.parse({
      name: "New Name",
    });
    expect(parsed.name).toBe("New Name");
  });

  it("accepts valid update with multiple fields", () => {
    const parsed = updateCommunitySchema.parse({
      name: "New Name",
      status: "active",
    });
    expect(parsed.name).toBe("New Name");
    expect(parsed.status).toBe("active");
  });

  it("rejects update with only undefined fields", () => {
    const result = updateCommunitySchema.safeParse({
      name: undefined,
      niche: undefined,
      slug: undefined,
      status: undefined,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty update object", () => {
    const result = updateCommunitySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts valid slug", () => {
    const parsed = updateCommunitySchema.parse({
      slug: "my-slug-123",
    });
    expect(parsed.slug).toBe("my-slug-123");
  });

  it("lowercases and trims slug", () => {
    const parsed = updateCommunitySchema.parse({
      slug: "  My-Slug  ",
    });
    expect(parsed.slug).toBe("my-slug");
  });

  it("rejects slug with spaces", () => {
    const result = updateCommunitySchema.safeParse({
      slug: "has spaces",
    });
    expect(result.success).toBe(false);
  });

  it("rejects slug with double hyphens", () => {
    const result = updateCommunitySchema.safeParse({
      slug: "--bad--",
    });
    expect(result.success).toBe(false);
  });

  it("rejects slug with trailing hyphen", () => {
    const result = updateCommunitySchema.safeParse({
      slug: "bad-",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid status values", () => {
    const activeResult = updateCommunitySchema.safeParse({ status: "active" });
    const pausedResult = updateCommunitySchema.safeParse({ status: "paused" });
    const archivedResult = updateCommunitySchema.safeParse({ status: "archived" });
    expect(activeResult.success).toBe(true);
    expect(pausedResult.success).toBe(true);
    expect(archivedResult.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const result = updateCommunitySchema.safeParse({
      status: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("createTierSchema", () => {
  it("accepts a valid tier creation", () => {
    const parsed = createTierSchema.parse({
      name: "Premium",
      priceAmount: 100000,
      billingCycle: "monthly",
    });
    expect(parsed.name).toBe("Premium");
    expect(parsed.priceAmount).toBe(100000);
    expect(parsed.billingCycle).toBe("monthly");
  });

  it("accepts zero price", () => {
    const parsed = createTierSchema.parse({
      name: "Free",
      priceAmount: 0,
      billingCycle: "monthly",
    });
    expect(parsed.priceAmount).toBe(0);
  });

  it("rejects negative price", () => {
    const result = createTierSchema.safeParse({
      name: "Invalid",
      priceAmount: -100,
      billingCycle: "monthly",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer price", () => {
    const result = createTierSchema.safeParse({
      name: "Invalid",
      priceAmount: 100.5,
      billingCycle: "monthly",
    });
    expect(result.success).toBe(false);
  });

  it("rejects price exceeding max bound (2_000_000_000)", () => {
    const result = createTierSchema.safeParse({
      name: "Invalid",
      priceAmount: 2_000_000_001,
      billingCycle: "monthly",
    });
    expect(result.success).toBe(false);
  });

  it("accepts price at max bound (2_000_000_000)", () => {
    const result = createTierSchema.safeParse({
      name: "Expensive",
      priceAmount: 2_000_000_000,
      billingCycle: "monthly",
    });
    expect(result.success).toBe(true);
  });

  it("accepts all valid billing cycles", () => {
    const monthlyResult = createTierSchema.safeParse({
      name: "Test",
      priceAmount: 0,
      billingCycle: "monthly",
    });
    const quarterlyResult = createTierSchema.safeParse({
      name: "Test",
      priceAmount: 0,
      billingCycle: "quarterly",
    });
    const yearlyResult = createTierSchema.safeParse({
      name: "Test",
      priceAmount: 0,
      billingCycle: "yearly",
    });
    expect(monthlyResult.success).toBe(true);
    expect(quarterlyResult.success).toBe(true);
    expect(yearlyResult.success).toBe(true);
  });

  it("rejects invalid billing cycle", () => {
    const result = createTierSchema.safeParse({
      name: "Test",
      priceAmount: 0,
      billingCycle: "weekly",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateTierSchema", () => {
  it("accepts valid update with price only", () => {
    const parsed = updateTierSchema.parse({
      priceAmount: 150000,
    });
    expect(parsed.priceAmount).toBe(150000);
  });

  it("rejects update with only undefined fields", () => {
    const result = updateTierSchema.safeParse({
      name: undefined,
      priceAmount: undefined,
      billingCycle: undefined,
      isActive: undefined,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty update object", () => {
    const result = updateTierSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects negative price", () => {
    const result = updateTierSchema.safeParse({
      priceAmount: -100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects price exceeding max bound", () => {
    const result = updateTierSchema.safeParse({
      priceAmount: 2_000_000_001,
    });
    expect(result.success).toBe(false);
  });

  it("accepts boolean isActive", () => {
    const trueResult = updateTierSchema.safeParse({ isActive: true });
    const falseResult = updateTierSchema.safeParse({ isActive: false });
    expect(trueResult.success).toBe(true);
    expect(falseResult.success).toBe(true);
  });

  it("rejects non-boolean isActive", () => {
    const result = updateTierSchema.safeParse({
      isActive: "true",
    });
    expect(result.success).toBe(false);
  });
});

describe("connectChannelSchema", () => {
  it("accepts valid WhatsApp connection", () => {
    const parsed = connectChannelSchema.parse({
      platform: "whatsapp",
      externalGroupId: "120363123456789@g.us",
    });
    expect(parsed.platform).toBe("whatsapp");
    expect(parsed.externalGroupId).toBe("120363123456789@g.us");
  });

  it("accepts valid Telegram connection", () => {
    const parsed = connectChannelSchema.parse({
      platform: "telegram",
      externalGroupId: "-1001234567890",
    });
    expect(parsed.platform).toBe("telegram");
  });

  it("rejects invalid platform", () => {
    const result = connectChannelSchema.safeParse({
      platform: "discord",
      externalGroupId: "123456",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty external group ID", () => {
    const result = connectChannelSchema.safeParse({
      platform: "whatsapp",
      externalGroupId: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects external group ID longer than 255 characters", () => {
    const result = connectChannelSchema.safeParse({
      platform: "whatsapp",
      externalGroupId: "a".repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it("trims external group ID", () => {
    const parsed = connectChannelSchema.parse({
      platform: "whatsapp",
      externalGroupId: "  123-456-789  ",
    });
    expect(parsed.externalGroupId).toBe("123-456-789");
  });

  /**
   * A TELEGRAM CHANNEL MUST CARRY THE NUMERIC CHAT ID, and this is a deliberate
   * tightening of an endpoint that used to accept any 1–255 string.
   *
   * `@username` works for granting — Telegram accepts it as a `chat_id` — so nothing
   * fails visibly. But the inbound `chat_member` update carries `chat.id` as a NUMBER,
   * and the membership lookup that records a joiner's Telegram user id requires the
   * membership to belong to the chat the update came from. `@kelasbudi` never equals
   * `-1001234567890`, so the update is dropped as `unknown_invite_link`,
   * `external_member_id` stays null, and every later revocation for that community
   * reports `no_provider_member_id_recorded` forever — a log line documented as
   * ordinary noise. Members could be granted access and never removed, silently.
   */
  describe("telegram requires a numeric chat id", () => {
    it("rejects an @username, which grants fine but can never match an inbound update", () => {
      const result = connectChannelSchema.safeParse({
        platform: "telegram",
        externalGroupId: "@kelasbudi",
      });

      expect(result.success).toBe(false);
      // The creator has to be told what to do instead: @username is the form they see
      // in the Telegram client, so this is the natural mistake, not an exotic one.
      const issue = result.error!.issues[0];
      expect(issue.path).toEqual(["externalGroupId"]);
      expect(issue.message).toContain("NUMERIC");
      expect(issue.message).toContain("-1001234567890");
    });

    it("rejects the other shapes Telegram or a creator might offer", () => {
      for (const externalGroupId of [
        "@kelasbudi",
        "kelasbudi",
        "https://t.me/kelasbudi",
        "t.me/+AbCdEf",
        "-100 1234567890",
        "-1001234567890x",
        "1.5e9",
      ]) {
        const result = connectChannelSchema.safeParse({
          platform: "telegram",
          externalGroupId,
        });
        expect(result.success).toBe(false);
      }
    });

    it("accepts the numeric ids Telegram actually reports", () => {
      // Supergroups and channels are negative; a plain group or a private chat is not.
      // The sign is not the constraint — matching an inbound `chat.id` is.
      for (const externalGroupId of ["-1001234567890", "-987654321", "123456789"]) {
        const parsed = connectChannelSchema.parse({ platform: "telegram", externalGroupId });
        expect(parsed.externalGroupId).toBe(externalGroupId);
      }
    });

    it("trims before checking, so a pasted id with whitespace is accepted", () => {
      const parsed = connectChannelSchema.parse({
        platform: "telegram",
        externalGroupId: "  -1001234567890\n",
      });
      expect(parsed.externalGroupId).toBe("-1001234567890");
    });

    it("leaves WhatsApp group ids alone — nothing inbound depends on their format", () => {
      const parsed = connectChannelSchema.parse({
        platform: "whatsapp",
        externalGroupId: "120363123456789@g.us",
      });
      expect(parsed.externalGroupId).toBe("120363123456789@g.us");
    });
  });
});
