import { describe, expect, test } from "bun:test";
import type { NotificationRepositoryPort } from "../ports/notification-repository.port";
import { NOTIFICATION_KIND, NotifyOf } from "./notify";
import { FollowUser } from "./follow-user";
import { JoinCommunity } from "./join-community";

const RECIPIENT = "11111111-0000-4000-8000-000000000000";
const ACTOR = "22222222-0000-4000-8000-000000000000";

class FakeNotifications implements NotificationRepositoryPort {
  written: unknown[] = [];
  shouldThrow = false;
  async create(input: unknown): Promise<void> {
    if (this.shouldThrow) throw new Error("database is on fire");
    this.written.push(input);
  }
  // Unreached by these tests — `NotifyOf` only ever writes.
  async listFor() {
    return [];
  }
  async unreadCountFor() {
    return 0;
  }
  async markAllRead() {}
}

function subject() {
  const notifications = new FakeNotifications();
  const logged: string[] = [];
  return {
    notifications,
    logged,
    notify: new NotifyOf(notifications, (line) => logged.push(line)),
  };
}

describe("NotifyOf", () => {
  test("records a notification for the recipient", async () => {
    const s = subject();

    await s.notify.record({
      userId: RECIPIENT,
      kind: NOTIFICATION_KIND.comment,
      actorId: ACTOR,
      postId: "post-1",
    });

    expect(s.notifications.written).toEqual([
      { userId: RECIPIENT, kind: "comment", actorId: ACTOR, postId: "post-1" },
    ]);
  });

  /**
   * ONE table over all four kinds from one shape, not four tests that each
   * happen to remember — the rule lives in this class precisely so no call
   * site has to.
   */
  test.each(Object.values(NOTIFICATION_KIND))(
    "writes nothing when the actor IS the recipient (%s)",
    async (kind) => {
      const s = subject();

      await s.notify.record({ userId: ACTOR, kind, actorId: ACTOR });

      expect(s.notifications.written).toEqual([]);
      // Silent: there is nothing wrong here, so nothing to report.
      expect(s.logged).toEqual([]);
    }
  );

  /**
   * **The most important test in this phase.** This class runs after the
   * action it reports has committed; letting a rejection propagate would make
   * a bug in notifications fail commenting.
   */
  test("a failing write is swallowed, not thrown", async () => {
    const s = subject();
    s.notifications.shouldThrow = true;

    // No `rejects` — the point is that this resolves.
    await s.notify.record({ userId: RECIPIENT, kind: NOTIFICATION_KIND.follow, actorId: ACTOR });

    expect(s.logged.length).toBe(1);
  });

  test("and the failure is REPORTED, naming the kind and the recipient", async () => {
    const s = subject();
    s.notifications.shouldThrow = true;

    await s.notify.record({ userId: RECIPIENT, kind: NOTIFICATION_KIND.join, actorId: ACTOR });

    // A silent swallow would make a broken notification path invisible until
    // somebody noticed the bell had gone quiet.
    expect(s.logged[0]).toContain("join");
    expect(s.logged[0]).toContain(RECIPIENT);
    expect(s.logged[0]).toContain("database is on fire");
  });
});

/**
 * **The regression this phase is actually about.**
 *
 * `NotifyOf` is hooked into four shipped use cases. Its whole contract is
 * that a failure there cannot reach the action — so these drive the REAL use
 * cases with a repository that throws, and assert the action still happened.
 *
 * Without these, a broken notification path would be silent in development
 * and would take commenting down in production.
 */
describe("a broken notification path never breaks its action", () => {
  function explodingNotifier(): NotifyOf {
    const logged: string[] = [];
    return new NotifyOf(
      {
        async create() {
          throw new Error("database is on fire");
        },
        async listFor() {
          return [];
        },
        async unreadCountFor() {
          return 0;
        },
        async markAllRead() {},
      },
      (line) => logged.push(line)
    );
  }

  test("a follow still happens", async () => {
    const followed: string[] = [];
    const useCase = new FollowUser(
      {
        async findByHandle() {
          return { id: "target", handle: "wildan" } as never;
        },
      } as never,
      {
        async follow(followerId: string) {
          followed.push(followerId);
        },
      } as never,
      explodingNotifier()
    );

    await useCase.execute({ followerId: "rina", handle: "wildan", action: "follow" });

    // The follow landed even though the notification could not be written.
    expect(followed).toEqual(["rina"]);
  });

  test("a join still happens", async () => {
    const joined: string[] = [];
    const useCase = new JoinCommunity(
      {
        async findBySlug() {
          return { id: "community-1", ownerId: "owner-1" } as never;
        },
        async join(communityId: string) {
          joined.push(communityId);
        },
      } as never,
      explodingNotifier()
    );

    const result = await useCase.execute({
      userId: "rina",
      slug: "kelas-desain",
      action: "join",
    });

    expect(joined).toEqual(["community-1"]);
    expect(result).toEqual({ member: true });
  });
});
