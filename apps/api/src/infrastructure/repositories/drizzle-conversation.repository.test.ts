import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleConversationRepository } from "./drizzle-conversation.repository";

const repository = new DrizzleConversationRepository(db);

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

describe("DrizzleConversationRepository.findOrCreateBetween", () => {
  beforeEach(resetDatabase);

  /**
   * **The guarantee this feature rests on.** Without the canonical ordering,
   * A-opens-B and B-opens-A are two rows, and neither person sees the other's
   * messages — a failure that looks exactly like being ignored.
   */
  test("both directions resolve to the SAME conversation", async () => {
    const a = await seedUser();
    const b = await seedUser();

    const opened = await repository.findOrCreateBetween(a.id, b.id);
    const reopened = await repository.findOrCreateBetween(b.id, a.id);

    expect(reopened.id).toBe(opened.id);
  });

  test("is idempotent — reopening returns the existing thread", async () => {
    const a = await seedUser();
    const b = await seedUser();

    const first = await repository.findOrCreateBetween(a.id, b.id);
    const second = await repository.findOrCreateBetween(a.id, b.id);

    expect(second.id).toBe(first.id);
  });

  test("different pairs get different conversations", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const c = await seedUser();

    const ab = await repository.findOrCreateBetween(a.id, b.id);
    const ac = await repository.findOrCreateBetween(a.id, c.id);

    expect(ab.id).not.toBe(ac.id);
  });
});

describe("DrizzleConversationRepository — the list", () => {
  beforeEach(resetDatabase);

  test("names the OTHER person, from whichever side is asking", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await repository.findOrCreateBetween(a.id, b.id);

    const asA = await repository.listFor(a.id);
    const asB = await repository.listFor(b.id);

    expect(asA[0]!.otherHandle).toBe(b.handle);
    expect(asB[0]!.otherHandle).toBe(a.handle);
  });

  test("carries the last message as its preview", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const { id } = await repository.findOrCreateBetween(a.id, b.id);
    await repository.send(id, a.id, "pertama");
    await repository.send(id, b.id, "terakhir");

    expect((await repository.listFor(a.id))[0]!.lastMessageBody).toBe("terakhir");
  });

  test("a conversation nobody has spoken in has no preview and still appears", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await repository.findOrCreateBetween(a.id, b.id);

    const rows = await repository.listFor(a.id);

    expect(rows.length).toBe(1);
    expect(rows[0]!.lastMessageBody).toBeNull();
  });

  /** Counting your own messages as unread would make the badge never clear. */
  test("unread excludes your OWN messages", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const { id } = await repository.findOrCreateBetween(a.id, b.id);
    await repository.send(id, a.id, "dari saya");
    await repository.send(id, b.id, "dari dia");

    expect((await repository.listFor(a.id))[0]!.unreadCount).toBe(1);
    expect((await repository.listFor(b.id))[0]!.unreadCount).toBe(1);
  });

  /**
   * A null read mark means never opened, which must count everything — and it
   * falls out of the comparison rather than needing a branch.
   */
  test("a conversation never opened counts every incoming message", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const { id } = await repository.findOrCreateBetween(a.id, b.id);
    await repository.send(id, b.id, "satu");
    await repository.send(id, b.id, "dua");

    expect((await repository.listFor(a.id))[0]!.unreadCount).toBe(2);
  });

  test("reading clears MY count and leaves the other side's alone", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const { id } = await repository.findOrCreateBetween(a.id, b.id);
    await repository.send(id, b.id, "untuk a");
    await repository.send(id, a.id, "untuk b");

    await repository.markRead(id, a.id);

    expect((await repository.listFor(a.id))[0]!.unreadCount).toBe(0);
    expect((await repository.listFor(b.id))[0]!.unreadCount).toBe(1);
  });

  test("is ordered by most recent activity", async () => {
    const me = await seedUser();
    const quiet = await seedUser();
    const busy = await seedUser();
    await repository.findOrCreateBetween(me.id, quiet.id);
    const { id } = await repository.findOrCreateBetween(me.id, busy.id);
    await repository.send(id, busy.id, "halo");

    expect((await repository.listFor(me.id)).map((row) => row.otherHandle)).toEqual([
      busy.handle,
      quiet.handle,
    ]);
  });

  test("somebody else's conversations are not in it", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const stranger = await seedUser();
    await repository.findOrCreateBetween(a.id, b.id);

    expect(await repository.listFor(stranger.id)).toEqual([]);
  });
});

describe("DrizzleConversationRepository — messages and access", () => {
  beforeEach(resetDatabase);

  test("messages read oldest first, with the sender's handle", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const { id } = await repository.findOrCreateBetween(a.id, b.id);
    await repository.send(id, a.id, "pertama");
    await repository.send(id, b.id, "kedua");

    const rows = await repository.listMessages(id, 50);

    expect(rows.map((row) => [row.senderHandle, row.body])).toEqual([
      [a.handle, "pertama"],
      [b.handle, "kedua"],
    ]);
  });

  test("both participants resolve it; a stranger does not", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const stranger = await seedUser();
    const { id } = await repository.findOrCreateBetween(a.id, b.id);

    expect(await repository.findParticipating(id, a.id)).not.toBeNull();
    expect(await repository.findParticipating(id, b.id)).not.toBeNull();
    // Absence and refusal collapse into one answer, which is what lets the
    // route 404 both rather than confirming the id exists.
    expect(await repository.findParticipating(id, stranger.id)).toBeNull();
  });
});
