/**
 * WHAT A CREATOR SEES IN THEIR ACTIVITY FEED, AND WHAT THEY DO NOT.
 *
 * `activity_log` holds 18 event types and MOST OF THEM ARE INTERNAL DIAGNOSTICS.
 * A raw feed of `access_not_revoked` and `churn_revoke_skipped` rows is noise at
 * best and alarming at worst: they describe a retry deciding not to act, which the
 * system then handles by itself. So this module is an ALLOWLIST, not a denylist —
 * an event type nobody has classified is HIDDEN, and adding one is a decision
 * somebody has to make rather than a default that shows creators our plumbing.
 *
 * Three facts the table's own docstring in `db/schema.ts` records, all of which
 * this module exists to respect:
 *
 *  1. ONE REMINDER WRITES TWO ROWS — `renewal_reminder_queued` when the stage is
 *     claimed, then `renewal_reminder_sent` when the message reaches the provider.
 *     Only `_sent` means the member was told, so only `_sent` is visible. Showing
 *     both doubles every reminder figure a creator ever reads, and the error is
 *     invisible until they count by hand.
 *  2. `renewed` IS NOT `joined`. A renewal is the same member paying again;
 *     conflating them inflates every growth figure.
 *  3. `renewal_reminder` rows are DELETED on renewal, so reminder history comes
 *     from here and nowhere else.
 *
 * PURE, AND IT IMPORTS NOTHING. Every label a creator reads is decided here, so
 * the labels are testable without a database or a browser — and the two
 * `*_manual_required` warnings, which are the entries a creator must not scroll
 * past, are testable at all.
 *
 * Labels are INDONESIAN. Every member-facing string in this product is, and the
 * dashboard is for Indonesian creators.
 */

/**
 * How prominently the UI must render an entry.
 *
 * `"warning"` means AUTOMATION COULD NOT COMPLETE AND A HUMAN HAS TO ACT — a
 * member who paid is not in the group, or a member who churned is still in it.
 * Task 7 renders these visually distinct from ordinary events, because a creator
 * scrolling past one costs somebody their access or leaves a non-payer inside.
 */
export type ActivitySeverity = "info" | "warning";

export interface ActivityEventDescription {
  /** Indonesian, creator-facing, and never interpolated from raw data — see below. */
  label: string;
  severity: ActivitySeverity;
}

/**
 * Reads a string field off a jsonb `metadata` value, or `undefined`.
 *
 * Defensive because `metadata` comes out of a jsonb column as `unknown` and a row
 * can outlive the deploy that wrote it. A feed that throws on one malformed row
 * shows a creator NOTHING, which is a much worse failure than one entry reading a
 * little less specifically.
 */
function stringField(metadata: unknown, key: string): string | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function booleanField(metadata: unknown, key: string): boolean | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Reminder stages in Indonesian, keyed by `REMINDER_STAGES` in
 * `domain/renewal-schedule.ts`.
 *
 * A LOOKUP RATHER THAN INTERPOLATION, and that is the rule for every metadata
 * value that reaches a label. `metadata` is written by five different use-cases
 * and read here as `unknown`; splicing a value into a creator-facing string would
 * mean whatever a future writer puts in that column is rendered in a dashboard
 * sight-unseen. An unrecognised stage therefore falls back to the plain label
 * rather than showing `overdue_30d` to somebody who has never read this codebase.
 */
const REMINDER_STAGE_LABELS: Record<string, string> = {
  pre_3d: "3 hari sebelum jatuh tempo",
  due: "jatuh tempo hari ini",
  overdue_1d: "terlambat 1 hari",
  overdue_3d: "terlambat 3 hari",
  overdue_7d: "terlambat 7 hari",
};

/** Platform names as a person writes them. Same lookup-not-interpolation rule. */
const PLATFORM_LABELS: Record<string, string> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};

/**
 * Why ONE member did not get a "we're live" message, in Indonesian. Same
 * lookup-not-interpolation rule as `REMINDER_STAGE_LABELS`/`PLATFORM_LABELS` — the
 * `reason` field is written by `NotifyStreamLive`, a use-case in a different file, and
 * a value it starts writing tomorrow must not appear here as a raw snake_case string.
 */
const STREAM_NOTIFY_SKIP_REASON_LABELS: Record<string, string> = {
  event_not_live: "siaran sudah berakhir",
  subscription_not_active: "anggota sudah tidak aktif",
  // Review round 2: this member IS active — just not for this event's own
  // community — so it must not share `subscription_not_active`'s label, which
  // would tell a creator an active member is inactive.
  subscription_wrong_community: "anggota bukan bagian dari komunitas ini",
};

/** Appends ` (detail)` when there is a detail, and nothing otherwise. */
function withDetail(label: string, detail: string | undefined): string {
  return detail === undefined ? label : `${label} (${detail})`;
}

type Describer = (metadata: unknown) => ActivityEventDescription;

/**
 * THE ALLOWLIST. Its keys are the only event types a creator ever sees, and each
 * one owns its own label.
 *
 * The six original ordinary events are the business happening: somebody joined,
 * renewed, left, was reminded, was let into the group, was removed from it. Task 5
 * adds four more: a stream going live, a stream ending, one member being told about
 * it, and one member deliberately NOT being told (with why) — visible for the same
 * reason `channel_access_granted`/`channel_access_revoked` are, despite firing once
 * per member rather than once per creator action: a creator watching their own
 * go-live wants to see it land, member by member, the same way they watch invites
 * land. The two `*_manual_required` entries are the ones that need a person.
 *
 * DELIBERATELY ABSENT, and why:
 *   renewal_reminder_queued    the `_sent` row is the delivery — showing both doubles
 *                              every reminder count
 *   renewal_reminder_skipped   the pass decided not to send (an archived community);
 *                              nothing happened and nothing is owed
 *   renewal_reminder_not_sent  a provider failure the outbox is already retrying
 *   access_not_granted         ditto, for a grant
 *   access_not_revoked         ditto, for a revocation — and the retry writes
 *                              `channel_access_revoked` or
 *                              `revocation_manual_required` when it resolves, so the
 *                              creator hears the OUTCOME rather than each attempt
 *   churn_revoke_skipped       an archived community does not evict its members
 */
const DESCRIBERS: Record<string, Describer> = {
  joined: () => ({ label: "Anggota baru bergabung", severity: "info" }),

  // NOT "bergabung". A renewal is the same member paying again, and a feed that
  // says "joined" for it makes a creator's growth look better than it is.
  renewed: () => ({ label: "Keanggotaan diperpanjang", severity: "info" }),

  churned: () => ({
    label: "Anggota berhenti — masa tenggang berakhir",
    severity: "info",
  }),

  renewal_reminder_sent: (metadata) => ({
    label: withDetail(
      "Pengingat perpanjangan terkirim",
      REMINDER_STAGE_LABELS[stringField(metadata, "stage") ?? ""]
    ),
    severity: "info",
  }),

  channel_access_granted: (metadata) => ({
    label: withDetail(
      "Akses grup diberikan",
      PLATFORM_LABELS[stringField(metadata, "platform") ?? ""]
    ),
    severity: "info",
  }),

  channel_access_revoked: (metadata) => ({
    // `automated: false` means the membership is revoked in OUR records but the
    // provider did not carry it out — the outbox is retrying. Saying so is the
    // honest version: a creator who reads a flat "dicabut" believes the member is
    // out of the group when they may still be in it.
    label:
      booleanField(metadata, "automated") === false
        ? "Akses grup dicabut — belum diterapkan di grup, sedang dicoba ulang"
        : withDetail("Akses grup dicabut", PLATFORM_LABELS[stringField(metadata, "platform") ?? ""]),
    severity: "info",
  }),

  // ===================================================================
  // TASK 5: LIVE STREAMING. Written by `HandleStreamLifecycle`
  // (`stream_live`/`stream_ended`) and `NotifyStreamLive`
  // (`stream_live_notified`/`stream_live_notify_skipped`).
  // ===================================================================
  stream_live: () => ({ label: "Siaran langsung dimulai", severity: "info" }),

  stream_ended: () => ({ label: "Siaran langsung berakhir", severity: "info" }),

  // One row per member, like `channel_access_granted` — a creator watching a go-live
  // wants to see delivery land, member by member.
  stream_live_notified: () => ({
    label: "Anggota diberi tahu bahwa siaran sedang berlangsung",
    severity: "info",
  }),

  // The counterpart: nothing to act on (no retry fixes a churned member or a stream
  // that already ended), so `info` rather than a warning — but named, not hidden,
  // because a creator who sees "50 diberi tahu" and wonders about the rest should be
  // able to find out why without reading a database.
  stream_live_notify_skipped: (metadata) => ({
    label: withDetail(
      "Anggota tidak diberi tahu tentang siaran langsung",
      STREAM_NOTIFY_SKIP_REASON_LABELS[stringField(metadata, "reason") ?? ""]
    ),
    severity: "info",
  }),

  // ===================================================================
  // THE TWO WARNINGS. Automation could not finish and a person has to act.
  //
  // `access_manual_required` means a PAYING MEMBER IS NOT IN THE GROUP and no
  // retry will fix it — a credential may be live and unrecorded, so the grant
  // fails closed rather than minting a second invite link (see
  // `channel_membership.linkMintedAt`). Only a deliberate reissue clears it.
  //
  // `revocation_manual_required` means a CHURNED MEMBER IS STILL IN THE GROUP,
  // usually because no Telegram user id was ever recorded for them, so
  // `banChatMember` has nothing to aim at.
  //
  // Both are silent, indefinite failures if a creator does not read them, which
  // is exactly why they are not `info`.
  // ===================================================================
  access_manual_required: () => ({
    label: "PERLU TINDAKAN: anggota harus ditambahkan ke grup secara manual",
    severity: "warning",
  }),

  revocation_manual_required: () => ({
    label: "PERLU TINDAKAN: anggota harus dikeluarkan dari grup secara manual",
    severity: "warning",
  }),

  // ===================================================================
  // FREE COMMUNITIES, TASK 4: the owner's decision on a join request.
  // Written by `DecideJoinRequest` either way, in the same transaction as the
  // decision itself.
  //
  // `join_request_rejected` is the one entry in this table with no OTHER
  // trace anywhere: rejection is silent BY DESIGN (no outbox row, no message
  // — see `DecideJoinRequest`'s own docstring), so this row is the only
  // record that a request was ever declined. `join_request_approved` is less
  // load-bearing in the same way `joined`/`channel_access_granted` already
  // are not the ONLY record of a paid join — `channel_access_granted` fires
  // too, once `grant_access` is processed — but it is included anyway, for
  // the same reason `joined` is: a creator watching their own dashboard wants
  // to see the decision land, not just its downstream effect.
  // ===================================================================
  join_request_approved: () => ({ label: "Permintaan bergabung disetujui", severity: "info" }),

  join_request_rejected: () => ({ label: "Permintaan bergabung ditolak", severity: "info" }),
};

/**
 * The event types a creator sees, for the `in (...)` predicate the repository
 * filters on.
 *
 * Typed as a non-empty tuple so `inArray` cannot be handed an empty list — an
 * empty `in ()` matches nothing, which would silently empty every creator's feed.
 */
export const CREATOR_VISIBLE_EVENTS: readonly [string, ...string[]] = Object.keys(
  DESCRIBERS
) as [string, ...string[]];

/**
 * An Indonesian label and a severity for one `activity_log` row, or `null` when
 * the event type is not creator-facing.
 *
 * `null` for hidden AND for unknown types, deliberately. It is the second of two
 * independent places the allowlist is enforced — the repository's SQL `in (...)`
 * is the first — so a diagnostic would have to get past both to reach a creator.
 * It also means a FUTURE phase's event type cannot appear in the feed as a raw
 * snake_case string that no product decision was ever made about.
 */
export function describeActivityEvent(
  eventType: string,
  metadata: unknown
): ActivityEventDescription | null {
  const describe = Object.prototype.hasOwnProperty.call(DESCRIBERS, eventType)
    ? DESCRIBERS[eventType]
    : undefined;
  return describe === undefined ? null : describe(metadata);
}
