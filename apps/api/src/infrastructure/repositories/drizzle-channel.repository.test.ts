import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { communities, creators } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { UniqueRule, UniqueViolationError } from "../../application/errors";
import { DrizzleChannelRepository } from "./drizzle-channel.repository";

beforeEach(resetDatabase);

async function makeCommunity(slug: string) {
  const [creator] = await db
    .insert(creators)
    .values({ name: "C", email: `${slug}@example.com` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: slug, slug })
    .returning();
  return community;
}

const GROUP = "-1001234567890";

describe("DrizzleChannelRepository", () => {
  it("creates a channel with the schema's defaults applied", async () => {
    const repository = new DrizzleChannelRepository(db);
    const community = await makeCommunity("kelas-a");

    const created = await repository.create({
      communityId: community.id,
      platform: "telegram",
      externalGroupId: GROUP,
    });

    expect(created.communityId).toBe(community.id);
    expect(created.externalGroupId).toBe(GROUP);
    // Phase 4 wires the real bot; until then a channel is recorded, not live.
    expect(created.botStatus).toBe("disconnected");
    expect(created.inviteLink).toBeNull();
  });

  it("lists only the requested community's channels", async () => {
    const repository = new DrizzleChannelRepository(db);
    const a = await makeCommunity("kelas-a");
    const b = await makeCommunity("kelas-b");

    await repository.create({ communityId: a.id, platform: "telegram", externalGroupId: "-1" });
    await repository.create({ communityId: b.id, platform: "telegram", externalGroupId: "-2" });

    const listed = await repository.listByCommunity(a.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].externalGroupId).toBe("-1");
  });

  it("rejects the same (platform, group) under a second community", async () => {
    const repository = new DrizzleChannelRepository(db);
    const a = await makeCommunity("kelas-a");
    const b = await makeCommunity("kelas-b");

    await repository.create({ communityId: a.id, platform: "telegram", externalGroupId: GROUP });

    const attempt = repository.create({
      communityId: b.id,
      platform: "telegram",
      externalGroupId: GROUP,
    });

    await expect(attempt).rejects.toBeInstanceOf(UniqueViolationError);
    await expect(attempt).rejects.toMatchObject({ rule: UniqueRule.channelPlatformGroup });
  });

  it("rejects the same (platform, group) twice under one community", async () => {
    const repository = new DrizzleChannelRepository(db);
    const community = await makeCommunity("kelas-a");

    await repository.create({
      communityId: community.id,
      platform: "telegram",
      externalGroupId: GROUP,
    });

    await expect(
      repository.create({
        communityId: community.id,
        platform: "telegram",
        externalGroupId: GROUP,
      })
    ).rejects.toBeInstanceOf(UniqueViolationError);
  });

  it("allows the same group id on a different platform", async () => {
    const repository = new DrizzleChannelRepository(db);
    const community = await makeCommunity("kelas-a");

    await repository.create({
      communityId: community.id,
      platform: "telegram",
      externalGroupId: GROUP,
    });
    const second = await repository.create({
      communityId: community.id,
      platform: "whatsapp",
      externalGroupId: GROUP,
    });

    expect(second.platform).toBe("whatsapp");
    expect(await repository.listByCommunity(community.id)).toHaveLength(2);
  });
});
