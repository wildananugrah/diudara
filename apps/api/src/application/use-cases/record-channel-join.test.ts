import { describe, expect, it } from "bun:test";
import type {
  ChannelMembershipRepositoryPort,
  RecordPlatformMemberIdOutcome,
} from "../ports/channel-membership-repository.port";
import { RecordChannelJoin } from "./record-channel-join";

const SECRET_LINK = "https://t.me/+this-is-a-bearer-credential";

function harness(outcome: RecordPlatformMemberIdOutcome) {
  const calls: { inviteLink: string; externalGroupId: string; externalMemberId: string }[] =
    [];
  const memberships: ChannelMembershipRepositoryPort = {
    async claim() {
      throw new Error("not used");
    },
    async recordGrant() {
      throw new Error("not used");
    },
    async releaseMintWindow() {
      throw new Error("not used");
    },
    async recordPlatformMemberIdByInviteLink(input) {
      calls.push(input);
      return outcome;
    },
    async revoke() {
      throw new Error("not used");
    },
    async listActiveForMemberInCommunity() {
      throw new Error("not used");
    },
    async findByIdWithChannel() {
      throw new Error("not used");
    },
  };
  return { calls, useCase: new RecordChannelJoin(memberships) };
}

function join(overrides: Partial<Parameters<RecordChannelJoin["execute"]>[0]> = {}) {
  return {
    platform: "telegram",
    externalGroupId: "-1001234567890",
    externalMemberId: "987654321",
    inviteLink: SECRET_LINK,
    ...overrides,
  };
}

async function captureWarnings(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

describe("RecordChannelJoin", () => {
  it("passes the link and the member id straight to the one conditional write", () => {
    // The database arbitrates. There is deliberately NO read-then-write in this
    // use-case: Telegram redelivers updates, and a pre-check would be a TOCTOU.
    const { calls, useCase } = harness({ outcome: "recorded", membershipId: "m1" });

    return useCase.execute(join()).then((result) => {
      expect(result).toEqual({ outcome: "recorded", membershipId: "m1" });
      // The group id goes through TOO: the membership the id lands on must belong to
      // the chat the update came from, not merely carry the link it quotes.
      expect(calls).toEqual([
        {
          inviteLink: SECRET_LINK,
          externalGroupId: "-1001234567890",
          externalMemberId: "987654321",
        },
      ]);
    });
  });

  it("says nothing at all on the ordinary paths", async () => {
    for (const outcome of [
      { outcome: "recorded", membershipId: "m1" },
      { outcome: "already_recorded", membershipId: "m1" },
    ] as const) {
      const { useCase } = harness(outcome);
      expect(await captureWarnings(() => useCase.execute(join()))).toEqual([]);
    }
  });

  describe("an invite link we do not recognise", () => {
    it("is reported, not thrown", async () => {
      const { useCase } = harness({ outcome: "unknown_invite_link" });

      let result: unknown;
      await captureWarnings(async () => {
        result = await useCase.execute(join({ inviteLink: SECRET_LINK }));
      });

      // A throw would become a non-2xx, and Telegram would redeliver an update
      // that can never succeed.
      expect(result).toEqual({ outcome: "unknown_invite_link" });
    });

    it("NEVER logs the link — not whole, not partial", async () => {
      // An invite link is a bearer credential (plan, Global Constraints), and this
      // is the one code path in the repository that receives one from outside.
      const { useCase } = harness({ outcome: "unknown_invite_link" });

      const warnings = await captureWarnings(() =>
        useCase.execute(join({ inviteLink: SECRET_LINK }))
      );

      const text = warnings.join("\n");
      expect(text).not.toContain(SECRET_LINK);
      expect(text).not.toContain("this-is-a-bearer-credential");
      expect(text).not.toContain("t.me");
      // But it DOES name the group, so an operator can tell which community it is.
      expect(text).toContain("-1001234567890");
    });
  });

  describe("a member id that disagrees with the one already recorded", () => {
    it("is reported and warned about, and the recorded id is not replaced", async () => {
      // The repository keeps the recorded id; this use-case's job is to make sure a
      // human hears about it, because the membership is now unsafe to revoke.
      const { useCase } = harness({ outcome: "conflicting_member_id", membershipId: "m9" });

      let result: unknown;
      const warnings = await captureWarnings(async () => {
        result = await useCase.execute(join());
      });

      expect(result).toEqual({ outcome: "conflicting_member_id", membershipId: "m9" });
      const text = warnings.join("\n");
      expect(text).toContain("m9");
      expect(text).toContain("KEPT");
      expect(text).not.toContain(SECRET_LINK);
    });
  });

  it("sanitises the platform and group labels it logs", async () => {
    // Both reach the log from an untrusted webhook body. A newline in either would
    // forge a second log line, and these lines are what an operator reads when
    // invites and revocations are not working.
    const { useCase } = harness({ outcome: "unknown_invite_link" });

    const warnings = await captureWarnings(() =>
      useCase.execute(
        join({
          platform: "telegram\n[security] all is well",
          externalGroupId: "-100\n[gating] nothing to see",
        })
      )
    );

    const text = warnings.join("\n");
    expect(text).not.toContain("[security] all is well");
    expect(text).not.toContain("[gating] nothing to see");
  });
});
