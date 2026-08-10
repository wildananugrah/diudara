import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { aiConversations, aiMessages, creators } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { NotFoundError } from "../../application/errors";
import { DrizzleAiConversationRepository } from "./drizzle-ai-conversation.repository";

beforeEach(resetDatabase);

const repo = new DrizzleAiConversationRepository(db);

async function seedCreator(name = "Test Creator") {
  const [creator] = await db.insert(creators).values({ name }).returning();
  return creator.id;
}

describe("DrizzleAiConversationRepository.createForCreator", () => {
  it("creates a new open conversation for the creator", async () => {
    const creatorId = await seedCreator();

    const conversation = await repo.createForCreator(creatorId);

    expect(conversation.creatorId).toBe(creatorId);
    expect(conversation.status).toBe("open");

    const rows = await db.select().from(aiConversations);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(conversation.id);
  });

  it("gives two conversations from the same creator distinct ids", async () => {
    const creatorId = await seedCreator();

    const first = await repo.createForCreator(creatorId);
    const second = await repo.createForCreator(creatorId);

    expect(first.id).not.toBe(second.id);
  });
});

describe("DrizzleAiConversationRepository.findForCreator", () => {
  it("finds a conversation owned by the caller", async () => {
    const creatorId = await seedCreator();
    const created = await repo.createForCreator(creatorId);

    const found = await repo.findForCreator(created.id, creatorId);

    expect(found).toEqual(created);
  });

  it("returns null for an unknown conversation id", async () => {
    const creatorId = await seedCreator();
    const found = await repo.findForCreator(
      "00000000-0000-0000-0000-000000000000",
      creatorId
    );
    expect(found).toBeNull();
  });

  // THE MUTATION-CHECK TARGET for creator scoping: strip the creatorId
  // condition from this method's WHERE clause and this must fail.
  it("returns null — not the record — for another creator's conversation", async () => {
    const owner = await seedCreator("Owner");
    const stranger = await seedCreator("Stranger");
    const created = await repo.createForCreator(owner);

    const found = await repo.findForCreator(created.id, stranger);

    expect(found).toBeNull();
  });
});

describe("DrizzleAiConversationRepository.appendMessage", () => {
  it("persists a user message and returns the stored record", async () => {
    const creatorId = await seedCreator();
    const conversation = await repo.createForCreator(creatorId);

    const message = await repo.appendMessage({
      conversationId: conversation.id,
      creatorId,
      role: "user",
      content: "Aku mau bikin komunitas trading",
    });

    expect(message.conversationId).toBe(conversation.id);
    expect(message.role).toBe("user");
    expect(message.content).toBe("Aku mau bikin komunitas trading");

    const rows = await db.select().from(aiMessages);
    expect(rows).toHaveLength(1);
  });

  it("persists an assistant message the same way", async () => {
    const creatorId = await seedCreator();
    const conversation = await repo.createForCreator(creatorId);

    const message = await repo.appendMessage({
      conversationId: conversation.id,
      creatorId,
      role: "assistant",
      content: "Halo! Ceritakan tentang komunitasmu.",
    });

    expect(message.role).toBe("assistant");
  });

  // THE MUTATION-CHECK TARGET for creator scoping on a WRITE path: dropping
  // the ownership check here would let a stranger append into (and read the
  // history of) a conversation they do not own.
  it("throws NotFoundError rather than writing into another creator's conversation", async () => {
    const owner = await seedCreator("Owner");
    const stranger = await seedCreator("Stranger");
    const conversation = await repo.createForCreator(owner);

    await expect(
      repo.appendMessage({
        conversationId: conversation.id,
        creatorId: stranger,
        role: "user",
        content: "mencoba menyusup",
      })
    ).rejects.toThrow(NotFoundError);

    const rows = await db.select().from(aiMessages);
    expect(rows).toHaveLength(0);
  });

  it("throws NotFoundError for an unknown conversation id", async () => {
    const creatorId = await seedCreator();

    await expect(
      repo.appendMessage({
        conversationId: "00000000-0000-0000-0000-000000000000",
        creatorId,
        role: "user",
        content: "halo",
      })
    ).rejects.toThrow(NotFoundError);
  });
});

describe("DrizzleAiConversationRepository.listMessages", () => {
  it("returns messages in creation order", async () => {
    const creatorId = await seedCreator();
    const conversation = await repo.createForCreator(creatorId);

    await repo.appendMessage({
      conversationId: conversation.id,
      creatorId,
      role: "user",
      content: "pertama",
    });
    await repo.appendMessage({
      conversationId: conversation.id,
      creatorId,
      role: "assistant",
      content: "kedua",
    });
    await repo.appendMessage({
      conversationId: conversation.id,
      creatorId,
      role: "user",
      content: "ketiga",
    });

    const messages = await repo.listMessages(conversation.id, creatorId);

    expect(messages.map((m) => m.content)).toEqual(["pertama", "kedua", "ketiga"]);
  });

  it("returns an empty list for a freshly created conversation", async () => {
    const creatorId = await seedCreator();
    const conversation = await repo.createForCreator(creatorId);

    expect(await repo.listMessages(conversation.id, creatorId)).toEqual([]);
  });

  it("scopes to another conversation's messages not leaking across conversations", async () => {
    const creatorId = await seedCreator();
    const conversationA = await repo.createForCreator(creatorId);
    const conversationB = await repo.createForCreator(creatorId);

    await repo.appendMessage({
      conversationId: conversationA.id,
      creatorId,
      role: "user",
      content: "punya A",
    });
    await repo.appendMessage({
      conversationId: conversationB.id,
      creatorId,
      role: "user",
      content: "punya B",
    });

    expect((await repo.listMessages(conversationA.id, creatorId)).map((m) => m.content)).toEqual([
      "punya A",
    ]);
    expect((await repo.listMessages(conversationB.id, creatorId)).map((m) => m.content)).toEqual([
      "punya B",
    ]);
  });

  // THE MUTATION-CHECK TARGET, read side: a stranger must never read another
  // creator's conversation history via this method either.
  it("throws NotFoundError rather than returning another creator's messages", async () => {
    const owner = await seedCreator("Owner");
    const stranger = await seedCreator("Stranger");
    const conversation = await repo.createForCreator(owner);
    await repo.appendMessage({
      conversationId: conversation.id,
      creatorId: owner,
      role: "user",
      content: "rahasia bisnis pemilik",
    });

    await expect(repo.listMessages(conversation.id, stranger)).rejects.toThrow(NotFoundError);
  });
});
