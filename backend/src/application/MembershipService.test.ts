import { describe, expect, test } from "bun:test";
import { MembershipService } from "./MembershipService.ts";
import { AccessPolicy } from "./AccessPolicy.ts";
import type {
  MembershipRepository, SubscriptionRepository, UserRepository,
} from "../domain/ports.ts";
import type { MemberRole, MemberStatus } from "../domain/types.ts";

const C = "bimbel-sbmptn";

type Seat = { role: MemberRole; status?: MemberStatus };

/**
 * Real AccessPolicy over a fake member table, so the owner check under test is
 * the one that actually ships.
 */
function makeService(seats: Record<string, Seat>, knownUsers = Object.keys(seats)) {
  const calls: Array<{ op: string; userId: string }> = [];

  const memberships = {
    find: async (communityId: string, userId: string) => {
      const seat = seats[userId];
      return seat && communityId === C
        ? { communityId, userId, role: seat.role, status: seat.status ?? "active", joinedAt: new Date() }
        : null;
    },
    markChurned: async (_c: string, userId: string) => { calls.push({ op: "markChurned", userId }); },
  } as unknown as MembershipRepository;

  const subscriptions = {
    cancelForMember: async (_c: string, userId: string) => { calls.push({ op: "cancelForMember", userId }); },
  } as unknown as SubscriptionRepository;

  const users = {
    findById: async (id: string) => (knownUsers.includes(id) ? { id } : null),
  } as unknown as UserRepository;

  return {
    service: new MembershipService(memberships, subscriptions, users, new AccessPolicy(memberships)),
    calls,
  };
}

const community = () => makeService({
  owner: { role: "owner" },
  admin: { role: "admin" },
  member: { role: "member" },
  gone: { role: "member", status: "churned" },
});

describe("removeMember", () => {
  test("the owner can remove an admin or a member", async () => {
    const { service, calls } = community();
    await expect(service.removeMember(C, "owner", "member")).resolves.toEqual({ ok: true });
    await expect(service.removeMember(C, "owner", "admin")).resolves.toEqual({ ok: true });
    expect(calls.filter((c) => c.op === "markChurned").map((c) => c.userId)).toEqual(["member", "admin"]);
  });

  test("nobody but the owner can remove anyone", async () => {
    // Admins moderate posts, but ending someone's paid access is the owner's call.
    const { service, calls } = community();
    for (const actor of ["admin", "member", "gone", "stranger"]) {
      await expect(service.removeMember(C, actor, "member")).rejects.toThrow(/pemilik komunitas/i);
    }
    expect(calls).toEqual([]);
  });

  test("the owner cannot be removed, even by themselves", async () => {
    const { service, calls } = community();
    await expect(service.removeMember(C, "owner", "owner"))
      .rejects.toThrow(/dirimu sendiri/i);
    expect(calls).toEqual([]);
  });

  test("removing marks churned AND cancels the subscription", async () => {
    // Access and billing have to move together, or a removed member still reads
    // as a paying subscriber on the dashboard.
    const { service, calls } = community();
    await service.removeMember(C, "owner", "member");
    expect(calls).toEqual([
      { op: "markChurned", userId: "member" },
      { op: "cancelForMember", userId: "member" },
    ]);
  });

  test("refuses someone who already left, so churn is not double counted", async () => {
    const { service, calls } = community();
    await expect(service.removeMember(C, "owner", "gone")).rejects.toThrow(/sudah keluar/i);
    expect(calls).toEqual([]);
  });

  test("distinguishes a non-member from a non-existent user", async () => {
    const { service } = makeService({ owner: { role: "owner" } }, ["owner", "outsider"]);
    await expect(service.removeMember(C, "owner", "outsider")).rejects.toThrow(/Anggota komunitas/);
    await expect(service.removeMember(C, "owner", "ghost")).rejects.toThrow(/Pengguna/);
  });

  test("an owner of one community cannot remove from another", async () => {
    // The seat lookup is scoped to the community in the request, so an owner
    // elsewhere is simply not an owner here.
    const { service, calls } = community();
    await expect(service.removeMember("finansial-cerdas", "owner", "member"))
      .rejects.toThrow(/pemilik komunitas/i);
    expect(calls).toEqual([]);
  });
});
