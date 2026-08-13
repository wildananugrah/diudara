import { describe, expect, it } from "bun:test";
import { RENEWED } from "../application/use-cases/handle-payment-webhook";
import {
  STREAM_ENDED_EVENT,
  STREAM_LIVE_EVENT,
} from "../application/use-cases/handle-stream-lifecycle";
import {
  STREAM_LIVE_NOTIFIED_EVENT,
  STREAM_LIVE_NOTIFY_SKIPPED_EVENT,
} from "../application/use-cases/notify-stream-live";
import { CHURNED, CHURN_REVOKE_SKIPPED } from "../application/use-cases/process-churn";
import {
  JOIN_REQUEST_APPROVED_EVENT,
  JOIN_REQUEST_REJECTED_EVENT,
} from "../application/use-cases/decide-join-request";
import { JOIN_REQUEST_NOTIFY_SKIPPED_EVENT } from "../application/use-cases/notify-join-request";
import {
  RENEWAL_REMINDER_QUEUED,
  RENEWAL_REMINDER_SKIPPED,
} from "../application/use-cases/process-renewals";
import { ACCESS_NOT_REVOKED } from "../application/use-cases/revoke-channel-access";
import {
  RENEWAL_REMINDER_NOT_SENT,
  RENEWAL_REMINDER_SENT,
} from "../application/use-cases/send-renewal-reminder";
import { CREATOR_VISIBLE_EVENTS, describeActivityEvent } from "./activity-feed";

/**
 * Every `activity_log.event_type` written anywhere in this codebase, which is the
 * universe this module has to have an opinion about.
 *
 * Written against the EXPORTED CONSTANTS wherever one exists — the same trick
 * `activity-log-contract.test.ts` uses — so renaming an event type in the code that
 * writes it fails here until the allowlist is updated with it. A feed whose
 * allowlist has silently stopped matching the writers shows a creator nothing at
 * all, and nothing else would notice.
 */
const ALL_EVENT_TYPES = [
  "joined",
  RENEWED,
  CHURNED,
  RENEWAL_REMINDER_QUEUED,
  RENEWAL_REMINDER_SENT,
  RENEWAL_REMINDER_SKIPPED,
  RENEWAL_REMINDER_NOT_SENT,
  "channel_access_granted",
  "channel_access_revoked",
  "access_manual_required",
  "access_not_granted",
  ACCESS_NOT_REVOKED,
  CHURN_REVOKE_SKIPPED,
  "revocation_manual_required",
  STREAM_LIVE_EVENT,
  STREAM_ENDED_EVENT,
  STREAM_LIVE_NOTIFIED_EVENT,
  STREAM_LIVE_NOTIFY_SKIPPED_EVENT,
  JOIN_REQUEST_APPROVED_EVENT,
  JOIN_REQUEST_REJECTED_EVENT,
  JOIN_REQUEST_NOTIFY_SKIPPED_EVENT,
] as const;

/** Internal diagnostics. A creator reading these learns nothing and worries anyway. */
const HIDDEN_EVENT_TYPES = [
  RENEWAL_REMINDER_QUEUED,
  RENEWAL_REMINDER_SKIPPED,
  RENEWAL_REMINDER_NOT_SENT,
  "access_not_granted",
  ACCESS_NOT_REVOKED,
  CHURN_REVOKE_SKIPPED,
] as const;

describe("CREATOR_VISIBLE_EVENTS", () => {
  it("covers all 21 event types, with every one either shown or hidden", () => {
    // The point is that there is no third category. A new event type must be
    // classified, not defaulted — a default of "show" puts diagnostics in front of
    // creators, and a default of "hide" loses a real event silently.
    expect(ALL_EVENT_TYPES).toHaveLength(21);

    const visible = new Set<string>(CREATOR_VISIBLE_EVENTS);
    const hidden = new Set<string>(HIDDEN_EVENT_TYPES);
    const unclassified = ALL_EVENT_TYPES.filter(
      (type) => !visible.has(type) && !hidden.has(type)
    );
    expect(unclassified).toEqual([]);

    const both = ALL_EVENT_TYPES.filter((type) => visible.has(type) && hidden.has(type));
    expect(both).toEqual([]);
  });

  it("shows exactly the thirteen ordinary events and the two warnings", () => {
    expect([...CREATOR_VISIBLE_EVENTS].sort()).toEqual(
      [
        "access_manual_required",
        "channel_access_granted",
        "channel_access_revoked",
        "churned",
        "joined",
        "renewal_reminder_sent",
        "renewed",
        "revocation_manual_required",
        STREAM_ENDED_EVENT,
        STREAM_LIVE_EVENT,
        STREAM_LIVE_NOTIFIED_EVENT,
        STREAM_LIVE_NOTIFY_SKIPPED_EVENT,
        JOIN_REQUEST_APPROVED_EVENT,
        JOIN_REQUEST_REJECTED_EVENT,
        JOIN_REQUEST_NOTIFY_SKIPPED_EVENT,
      ].sort()
    );
  });

  it("does NOT show renewal_reminder_queued, because the _sent row is the delivery", () => {
    // ONE REMINDER WRITES TWO ROWS. Showing both means a creator who counts by hand
    // finds twice as many reminders as went out, and the error is invisible until
    // they do.
    expect([...CREATOR_VISIBLE_EVENTS]).not.toContain(RENEWAL_REMINDER_QUEUED);
    expect([...CREATOR_VISIBLE_EVENTS]).toContain(RENEWAL_REMINDER_SENT);
  });

  it("hides every internal diagnostic", () => {
    for (const hidden of HIDDEN_EVENT_TYPES) {
      expect([...CREATOR_VISIBLE_EVENTS]).not.toContain(hidden);
    }
  });
});

describe("describeActivityEvent", () => {
  it("describes every visible event type", () => {
    for (const eventType of CREATOR_VISIBLE_EVENTS) {
      const described = describeActivityEvent(eventType, null);
      expect(described).not.toBeNull();
      expect(described!.label.length).toBeGreaterThan(0);
    }
  });

  it("returns null for every hidden event type", () => {
    // Belt and braces with the SQL allowlist: two independent places would both
    // have to be wrong for a diagnostic to reach a creator.
    for (const hidden of HIDDEN_EVENT_TYPES) {
      expect(describeActivityEvent(hidden, { stage: "due" })).toBeNull();
    }
  });

  it("returns null for an event type it has never heard of", () => {
    // A future phase's event type must not appear in the feed unlabelled, and must
    // not appear as a raw snake_case string either.
    expect(describeActivityEvent("course_completed", null)).toBeNull();
    expect(describeActivityEvent("", null)).toBeNull();
  });

  it("does not report a renewal as a new member", () => {
    // `renewed` and `joined` are distinct. A renewal is the same member paying
    // again, and conflating them inflates every growth figure a creator looks at.
    const joined = describeActivityEvent("joined", { amount: 50_000 })!;
    const renewed = describeActivityEvent(RENEWED, { amount: 50_000 })!;

    expect(renewed.label).not.toBe(joined.label);
    expect(joined.label).toContain("bergabung");
    expect(renewed.label).not.toContain("bergabung");
    expect(renewed.label).toContain("perpanjang");
  });

  it("names the reminder stage in Indonesian", () => {
    expect(describeActivityEvent(RENEWAL_REMINDER_SENT, { stage: "pre_3d" })!.label).toContain(
      "3 hari sebelum jatuh tempo"
    );
    expect(describeActivityEvent(RENEWAL_REMINDER_SENT, { stage: "overdue_7d" })!.label).toContain(
      "terlambat 7 hari"
    );
  });

  it("falls back to the plain label for a stage it does not recognise", () => {
    // `REMINDER_STAGES` can grow without this module being updated, and an
    // unrecognised stage must not put `[object Object]` or a raw `overdue_30d` in
    // front of a creator.
    const described = describeActivityEvent(RENEWAL_REMINDER_SENT, { stage: "overdue_30d" })!;
    expect(described.label).toContain("Pengingat perpanjangan terkirim");
    expect(described.label).not.toContain("overdue_30d");
  });

  it("names the platform on a grant", () => {
    expect(describeActivityEvent("channel_access_granted", { platform: "telegram" })!.label).toContain(
      "Telegram"
    );
  });

  it("says when a revocation was not carried out at the provider", () => {
    const automated = describeActivityEvent("channel_access_revoked", { automated: true })!;
    const manual = describeActivityEvent("channel_access_revoked", { automated: false })!;
    expect(manual.label).not.toBe(automated.label);
    expect(manual.label).toContain("belum");
  });

  it("marks the two *_manual_required types as warnings", () => {
    // These mean automation could not complete and a HUMAN HAS TO ACT. They are the
    // one thing in this feed a creator must not scroll past, so they carry a
    // severity the UI can render differently rather than a label it might not.
    expect(describeActivityEvent("access_manual_required", { reason: "mint_lost" })!.severity).toBe(
      "warning"
    );
    expect(
      describeActivityEvent("revocation_manual_required", { reason: "provider_rejected" })!.severity
    ).toBe("warning");
  });

  it("marks every ordinary event as info", () => {
    for (const eventType of [
      "joined",
      RENEWED,
      CHURNED,
      RENEWAL_REMINDER_SENT,
      "channel_access_granted",
      "channel_access_revoked",
      STREAM_LIVE_EVENT,
      STREAM_ENDED_EVENT,
      STREAM_LIVE_NOTIFIED_EVENT,
      STREAM_LIVE_NOTIFY_SKIPPED_EVENT,
      JOIN_REQUEST_APPROVED_EVENT,
      JOIN_REQUEST_REJECTED_EVENT,
      JOIN_REQUEST_NOTIFY_SKIPPED_EVENT,
    ]) {
      expect(describeActivityEvent(eventType, null)!.severity).toBe("info");
    }
  });

  it("names why a member was not told the stream is live", () => {
    expect(
      describeActivityEvent(STREAM_LIVE_NOTIFY_SKIPPED_EVENT, { reason: "event_not_live" })!.label
    ).toContain("siaran sudah berakhir");
    expect(
      describeActivityEvent(STREAM_LIVE_NOTIFY_SKIPPED_EVENT, {
        reason: "subscription_not_active",
      })!.label
    ).toContain("anggota sudah tidak aktif");
  });

  /**
   * Review round 2, important #4. A cross-community entitlement mismatch is NOT
   * the same fact as an inactive subscription — collapsing them would render
   * "anggota sudah tidak aktif" for a member who is, in fact, active. Its own
   * reason needs its own label, and that label must not read as "inactive".
   */
  it("gives a cross-community skip its own label, distinct from 'inactive'", () => {
    const label = describeActivityEvent(STREAM_LIVE_NOTIFY_SKIPPED_EVENT, {
      reason: "subscription_wrong_community",
    })!.label;
    expect(label).toContain("bukan bagian dari komunitas ini");
    expect(label).not.toContain("anggota sudah tidak aktif");
  });

  it("falls back to the plain label for a stream-skip reason it does not recognise", () => {
    const described = describeActivityEvent(STREAM_LIVE_NOTIFY_SKIPPED_EVENT, {
      reason: "some_future_reason",
    })!;
    expect(described.label).toContain("Anggota tidak diberi tahu tentang siaran langsung");
    expect(described.label).not.toContain("some_future_reason");
  });

  /**
   * Fix round 1. The reason used to be baked into the label literal — this pins
   * that it is now LOOKED UP (same shape as `STREAM_NOTIFY_SKIP_REASON_LABELS`),
   * and that the label is unambiguous about WHOSE WhatsApp number is missing:
   * this is shown to the pemilik themselves, and a bare "nomor WhatsApp belum
   * diatur" could otherwise read as being about the requesting member's number.
   */
  it("names why the owner was not told about a join request, unambiguously as their OWN number", () => {
    const label = describeActivityEvent(JOIN_REQUEST_NOTIFY_SKIPPED_EVENT, {
      reason: "creator_whatsapp_missing",
    })!.label;
    expect(label).toContain("nomor WhatsApp sendiri belum diatur");
  });

  it("falls back to the plain label for a join-request-skip reason it does not recognise", () => {
    const described = describeActivityEvent(JOIN_REQUEST_NOTIFY_SKIPPED_EVENT, {
      reason: "some_future_reason",
    })!;
    expect(described.label).toContain("Pemilik belum diberi tahu tentang permintaan bergabung");
    expect(described.label).not.toContain("some_future_reason");
  });

  it("survives metadata that is missing, null, or not an object at all", () => {
    // `metadata` is a jsonb column: a row can outlive the deploy that wrote it, and
    // a feed that throws on one malformed row shows a creator nothing.
    for (const metadata of [null, undefined, 42, "a string", [], true]) {
      expect(describeActivityEvent("joined", metadata)!.label.length).toBeGreaterThan(0);
      expect(
        describeActivityEvent(RENEWAL_REMINDER_SENT, metadata)!.label.length
      ).toBeGreaterThan(0);
    }
  });

  it("never puts a raw event type or a metadata value into a label", () => {
    // The labels are what a creator reads. A fallback that interpolated the raw
    // event type would leak `revocation_manual_required` into a dashboard, and a
    // fallback that interpolated metadata would leak whatever a future writer puts
    // there.
    for (const eventType of CREATOR_VISIBLE_EVENTS) {
      const label = describeActivityEvent(eventType, {
        secret: "s3cret-value",
        whatsappNumber: "+6281234567890",
      })!.label;
      expect(label).not.toContain(eventType);
      expect(label).not.toContain("s3cret-value");
      expect(label).not.toContain("+6281234567890");
    }
  });
});
