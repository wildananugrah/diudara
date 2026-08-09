import { describe, expect, it } from "bun:test";
import { FakeMessagingAdapter } from "./fake-messaging.adapter";
import {
  ProviderCallError,
  UnsupportedOperationError,
  type ProviderCallOutcome,
} from "../../application/errors";

describe("FakeMessagingAdapter", () => {
  it("issues an invite and records the call when gating is supported", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
    const { inviteLink } = await adapter.grantAccess({
      externalGroupId: "-100123",
      memberWhatsappNumber: "+6281234567890",
    });

    expect(inviteLink).toContain("http");
    expect(adapter.grants.length).toBe(1);
    expect(adapter.grants[0].externalGroupId).toBe("-100123");
  });

  it("issues a DISTINCT link per grant, so a link is never reused", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
    const a = await adapter.grantAccess({ externalGroupId: "-1", memberWhatsappNumber: "+621" });
    const b = await adapter.grantAccess({ externalGroupId: "-1", memberWhatsappNumber: "+622" });
    expect(a.inviteLink).not.toBe(b.inviteLink);
  });

  it("THROWS rather than no-opping when gating is unsupported", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    await expect(
      adapter.grantAccess({ externalGroupId: "-1", memberWhatsappNumber: "+621" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(adapter.grants.length).toBe(0);
  });

  it("throws on revoke when gating is unsupported", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    await expect(
      adapter.revokeAccess({ externalGroupId: "-1", externalMemberId: "m1" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("notifies regardless of gating capability", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    await adapter.notify({ toWhatsappNumber: "+6281234567890", message: "halo" });
    expect(adapter.notifications.length).toBe(1);
  });

  it("can be told to fail, so callers' retry paths are testable", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
    adapter.failNextGrant = true;
    await expect(
      adapter.grantAccess({ externalGroupId: "-1", memberWhatsappNumber: "+621" })
    ).rejects.toThrow();
  });

  /**
   * The fake has to be able to produce BOTH failure classes, because they have
   * opposite consequences in `GrantChannelAccess`: a failure the provider answered
   * releases the mint window (nothing was minted), one that never completed keeps it
   * (a link may be live and unrecorded). A fake that could only throw a plain Error
   * could not test the recovery path at all.
   */
  it("fails with the provider outcome it was given, defaulting `true` to fail-closed", async () => {
    const adapter = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
    const grant = { externalGroupId: "-1", memberWhatsappNumber: "+621" };

    for (const [setting, expected] of [
      ["rejected", "rejected"],
      ["indeterminate", "indeterminate"],
      // A test that does not think about the distinction must not get the permissive
      // branch by accident.
      [true, "indeterminate"],
    ] as const) {
      adapter.failNextGrant = setting;
      const error = (await adapter.grantAccess(grant).catch((e) => e)) as ProviderCallError;
      expect(error).toBeInstanceOf(ProviderCallError);
      expect(error.outcome).toBe(expected);
      // One-shot: it resets itself, so the next call succeeds.
      expect(adapter.failNextGrant as boolean | ProviderCallOutcome).toBe(false);
      await adapter.grantAccess(grant);
    }
  });
});
