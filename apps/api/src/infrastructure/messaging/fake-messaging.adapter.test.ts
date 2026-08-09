import { describe, expect, it } from "bun:test";
import { FakeMessagingAdapter } from "./fake-messaging.adapter";
import { UnsupportedOperationError } from "../../application/errors";

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
});
