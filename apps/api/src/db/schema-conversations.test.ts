import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "./client";
import { appUsers, conversations, directMessages } from "./schema";
import { resetDatabase } from "./test-helpers";

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

function constraintNameOf(error: unknown): unknown {
  return (error as { cause?: { constraint_name?: unknown } } | null)?.cause?.constraint_name;
}

let counter = 0;

async function seedUser() {
  counter += 1;
  const [user] = await db
    .insert(appUsers)
    .values({
      handle: `chat${counter}`,
      email: `chat${counter}@example.com`,
      passwordHash: "irrelevant-hash",
      displayName: `Chat ${counter}`,
    })
    .returning();
  return user!;
}

/** The pair, canonically ordered — which is what the use case must also do. */
function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

describe("conversation, the canonical pair", () => {
  beforeEach(resetDatabase);

  test("a correctly ordered pair is accepted", async () => {
    const [lower, higher] = ordered((await seedUser()).id, (await seedUser()).id);

    const [row] = await db
      .insert(conversations)
      .values({ lowerUserId: lower, higherUserId: higher })
      .returning();

    expect(row!.lowerUserId).toBe(lower);
    // Never opened by either side, which reads as "everything unread".
    expect(row!.lowerLastReadAt).toBeNull();
    expect(row!.higherLastReadAt).toBeNull();
  });

  /**
   * **The guarantee the whole feature rests on.** Without the ordering, the
   * same two people yield two rows depending on who spoke first, and neither
   * sees the other's messages — a failure that looks exactly like being
   * ignored.
   */
  test("a REVERSED pair is refused by the database, not merely by the use case", async () => {
    const [lower, higher] = ordered((await seedUser()).id, (await seedUser()).id);

    const error = await captureError(() =>
      db.insert(conversations).values({ lowerUserId: higher, higherUserId: lower })
    );

    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("conversation_ordered_pair");
  });

  test("a conversation with yourself cannot be stored", async () => {
    const me = (await seedUser()).id;

    const error = await captureError(() =>
      db.insert(conversations).values({ lowerUserId: me, higherUserId: me })
    );

    // `x < x` is false, so the ordering check already forbids it — no
    // separate no-self constraint is needed.
    expect(constraintNameOf(error)).toBe("conversation_ordered_pair");
  });

  test("a pair can only have ONE conversation", async () => {
    const [lower, higher] = ordered((await seedUser()).id, (await seedUser()).id);
    const pair = { lowerUserId: lower, higherUserId: higher };
    await db.insert(conversations).values(pair);

    const error = await captureError(() => db.insert(conversations).values(pair));

    expect(error).not.toBeNull();
  });
});

describe("direct_message", () => {
  beforeEach(resetDatabase);

  test("messages read oldest first within a conversation", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const [lower, higher] = ordered(a.id, b.id);
    const [conversation] = await db
      .insert(conversations)
      .values({ lowerUserId: lower, higherUserId: higher })
      .returning();

    await db.insert(directMessages).values([
      {
        conversationId: conversation!.id,
        senderId: a.id,
        body: "kedua",
        createdAt: new Date("2026-09-12T10:05:00.000Z"),
      },
      {
        conversationId: conversation!.id,
        senderId: b.id,
        body: "pertama",
        createdAt: new Date("2026-09-12T10:00:00.000Z"),
      },
    ]);

    const rows = await db
      .select({ body: directMessages.body })
      .from(directMessages)
      .orderBy(directMessages.createdAt);

    expect(rows.map((row) => row.body)).toEqual(["pertama", "kedua"]);
  });

  test("resetDatabase clears both, so a suite that chatted leaves nothing", async () => {
    const [lower, higher] = ordered((await seedUser()).id, (await seedUser()).id);
    const [conversation] = await db
      .insert(conversations)
      .values({ lowerUserId: lower, higherUserId: higher })
      .returning();
    await db
      .insert(directMessages)
      .values({ conversationId: conversation!.id, senderId: lower, body: "halo" });

    await resetDatabase();

    expect(await db.select().from(directMessages)).toHaveLength(0);
    expect(await db.select().from(conversations)).toHaveLength(0);
  });
});
