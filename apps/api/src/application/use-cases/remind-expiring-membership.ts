import { redactLinks, safeErrorSummary } from "../log-safety";
import type { ClockPort } from "../ports/clock.port";
import type { EmailProviderPort } from "../ports/email-provider.port";
import {
  MEMBERSHIP_REMINDER_NO_CHANNEL,
  MEMBERSHIP_REMINDER_SENT,
  type MembershipReminderRepositoryPort,
} from "../ports/membership-reminder-repository.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type { UserSubscriptionRow } from "../ports/user-subscription-repository.port";

/**
 * Just enough of `UserSubscriptionRepositoryPort` to find whom to warn.
 * `DrizzleUserSubscriptionRepository` satisfies it directly — the narrow shape is so a
 * test can supply a page-by-page double without implementing a nineteen-method port.
 */
export interface ExpiringMembershipRepository {
  listExpiringActive(input: {
    from: Date;
    to: Date;
    limit: number;
    after?: { currentPeriodEnd: Date; id: string };
  }): Promise<UserSubscriptionRow[]>;
}

/**
 * How far ahead of the end of a period a member is warned: three days.
 *
 * The same lead the old world's `pre_3d` stage uses, and for the same human reason —
 * long enough to act on over a weekend, short enough that the membership is still
 * something the member remembers having. It is NOT a grace period: access still stops
 * the instant the period ends (spec §3), because with no recurring charge anywhere in
 * this system there is nothing to retry and grace would simply be free access.
 *
 * Widening it costs nothing in messages — the claim is per membership, not per pass —
 * but it does change what a member is told: a warning three weeks out is not a
 * warning, it is a marketing email.
 */
export const MEMBERSHIP_REMINDER_LEAD_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Memberships read per QUERY, not per pass — same figure and same reasoning as
 * `ProcessRenewals`' own batch size: it bounds one result set while leaving any
 * realistic backlog's page count uninteresting.
 */
const DEFAULT_BATCH_SIZE = 500;

export interface RemindExpiringMembershipResult {
  /** Expiring memberships this pass looked at. */
  considered: number;
  /** Members this pass actually reached, over at least one channel. */
  reminded: number;
  /** Memberships already claimed, by an earlier pass or a concurrent one. */
  alreadyReminded: number;
  /**
   * Memberships DELIBERATELY not reminded because no channel could deliver at all.
   * Also written to `membership_reminder.outcome` — see the class docstring.
   */
  skipped: number;
  /**
   * Memberships whose reminder failed: every available channel threw, or something
   * before the send did. The claim is released, so the next pass retries.
   */
  failed: number;
}

export interface RemindExpiringMembershipOptions {
  /** Rows per query. The pass still covers every expiring membership — see `execute`. */
  batchSize?: number;
  /**
   * Where the deliberate no-channel skip is announced. Defaults to `console.warn`,
   * and is injectable only so a test can capture the line without capturing the real
   * console.
   */
  logWarn?: (line: string) => void;
  /** Where a per-row failure is announced. Defaults to `console.error`, as above. */
  logError?: (line: string) => void;
}

/**
 * Task 4 of Phase 5b: telling a member their membership is about to end.
 *
 * THIS IS THE ONLY THING THAT TELLS THEM. There is no recurring charge anywhere in
 * this system — the Xendit adapter has two operations and no tokenisation — so a
 * membership does not auto-renew: it ends, and the member buys again. Tasks 1-3 made
 * buying again possible; without this pass a membership simply stops and the member
 * finds out by discovering they cannot see something.
 *
 * FOUR RULES SHAPE EVERY LINE BELOW.
 *
 *  1. THE CLAIM COMES FIRST. `reminders.claim` inserts into `membership_reminder`
 *     with `ON CONFLICT DO NOTHING`, so the unique index decides who sends — never a
 *     read before it, which is a TOCTOU under READ COMMITTED and would have two
 *     overlapping passes both read "not yet" and both message the same member. This
 *     pass runs hourly across a three-day window, so a read-then-send would not need
 *     two workers to misbehave: it would need one restart.
 *
 *  2. EMAIL ALWAYS, PLUS WHATSAPP WHEN THERE IS A NUMBER. Every account has a
 *     verified, unique email; `app_user.whatsapp_number` is nullable because signup
 *     offers it and never requires it. Both, not either — email reaches everybody and
 *     WhatsApp is the channel this audience actually reads.
 *
 *  3. A SKIP THAT REACHES NOBODY IS RECORDED, NEVER SILENT. Both adapters are
 *     optional at boot (`selectEmailProvider` returns `null` on a box with no email
 *     configured), and a member may have no number, so "nobody can be reached" is a
 *     real state. It is written to `membership_reminder.outcome` as `no_channel` AND
 *     logged, for the reason `process-renewals.ts` gives for its own skip: *"the
 *     member was never told" is the failure mode of this whole phase, so the one case
 *     where it is intentional has to be visible in the audit trail.* A pass that
 *     silently reached nobody would otherwise look exactly like a pass that reached
 *     everybody.
 *
 *     THE SKIP IS RECORDED BUT NOT PERMANENT — review fix round 1, I1. The row stays
 *     (one per membership, updated in place, so an hourly pass cannot write 72 skip
 *     records across the window) but `no_channel` is the one outcome
 *     `MembershipReminderRepositoryPort.claim` will re-claim. It has to be: this
 *     branch is reachable only when the BOX has no email provider — `app_user.email`
 *     is `NOT NULL UNIQUE`, so a member always has an address — and treating it as
 *     final meant a worker deployed for one hour without email configuration
 *     permanently burned the reminder for every in-window member without a WhatsApp
 *     number, with fixing the configuration repairing nothing. A `sent` row is still
 *     final, because that member WAS told.
 *
 *  4. ONE MEMBERSHIP'S FAILURE MUST NOT ABORT THE PASS, and one CHANNEL's failure must
 *     not prevent the other. Each row is handled in its own try/catch and each channel
 *     is attempted in its own, so a Resend outage still lets WhatsApp through and a
 *     single bad row does not strand every member behind it.
 *
 * ==========================================================================
 * WHAT HAPPENS TO THE CLAIM WHEN ONE CHANNEL FAILS AND THE OTHER SUCCEEDS
 *
 * THE CLAIM IS KEPT. The member was told — over email, say, while the WhatsApp
 * gateway was down — so the reminder happened, and the failed channel is not retried.
 *
 * The two directions are not symmetrical, and the asymmetry is this pass's schedule.
 * Releasing the claim would put the membership back in front of the NEXT pass, an hour
 * later, which would re-send over the channel that already worked; across a three-day
 * window that is up to 72 emails about one membership ending. Keeping it costs the
 * member one missed WhatsApp message they already have by email. One is a nuisance,
 * the other is a dunning campaign — the identical trade `SendRenewalReminder` records
 * for `renewal_reminder`, reached from the other end.
 *
 * THE CLAIM IS RELEASED ONLY WHEN NOTHING AT ALL WAS DELIVERED — every channel that
 * existed threw, so nobody was told anything and there is no send to duplicate. That
 * is the one case where re-offering the membership to the next pass is a retry rather
 * than a second reminder. Note that this is a FAILURE, not the skip of rule 3: a skip
 * means there was no channel to try, keeps its claim, and is recorded.
 * ==========================================================================
 */
export class RemindExpiringMembership {
  private readonly batchSize: number;
  private readonly logWarn: (line: string) => void;
  private readonly logError: (line: string) => void;

  constructor(
    private readonly subscriptions: ExpiringMembershipRepository,
    /** Read-only: the subscriber's channels, and the owner this membership is to. */
    private readonly users: UserRepositoryPort,
    private readonly reminders: MembershipReminderRepositoryPort,
    /** `null` means email is DISABLED on this box — see `selectEmailProvider`. */
    private readonly email: EmailProviderPort | null,
    /**
     * How the member is reached over WhatsApp. Typed nullable even though
     * `bootstrapWorker` always has one, because spec §6 says both adapters are
     * optional and a use-case that assumes a channel exists is exactly how "nobody
     * was told" becomes unobservable.
     */
    private readonly notifier: MessagingProviderPort | null,
    /**
     * The phase's defining dependency. A `Date.now()` inside this class would make
     * the window boundary untestable, and this object lives for the lifetime of a
     * worker process — so the clock is read once per `execute`, never at
     * construction.
     */
    private readonly clock: ClockPort,
    /**
     * `appBaseUrl` is the public origin of `apps/web`, with no trailing slash, exactly
     * as `StartUserSubscription` receives it. Configuration, not a port, which is why
     * it arrives as a plain value — and it must come from `resolveAppBaseUrl` rather
     * than a literal, or every member of every deployment is sent to one developer's
     * laptop.
     */
    private readonly config: { appBaseUrl: string },
    options: RemindExpiringMembershipOptions = {}
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.logWarn = options.logWarn ?? ((line) => console.warn(line));
    this.logError = options.logError ?? ((line) => console.error(line));
  }

  async execute(): Promise<RemindExpiringMembershipResult> {
    // ONCE per pass, so every row is judged against the same instant — the same
    // reasoning `ProcessRenewals.execute` gives for reading its clock once.
    const now = this.clock.now();
    const windowEnd = new Date(now.getTime() + MEMBERSHIP_REMINDER_LEAD_MS);

    const result: RemindExpiringMembershipResult = {
      considered: 0,
      reminded: 0,
      alreadyReminded: 0,
      skipped: 0,
      failed: 0,
    };

    // PAGED BY KEYSET, not capped. A reminded membership does NOT leave this result
    // set — the claim lives in `membership_reminder`, not in a status the query could
    // filter on — so a pass that simply took the first `batchSize` rows would return
    // the same rows every time and never reach anybody behind them. `ProcessRenewals`
    // measured exactly that with a limit of 1 and two due members.
    //
    // The cursor is strictly increasing in the same order the query sorts by, so the
    // walk terminates and no row is visited twice.
    let after: { currentPeriodEnd: Date; id: string } | undefined;
    for (;;) {
      const page = await this.subscriptions.listExpiringActive({
        from: now,
        to: windowEnd,
        limit: this.batchSize,
        ...(after === undefined ? {} : { after }),
      });
      if (page.length === 0) break;
      result.considered += page.length;

      for (const row of page) {
        await this.remindOne(row, result);
      }

      const last = page[page.length - 1];
      if (last.currentPeriodEnd === null) {
        // Excluded by the query's `isNotNull`, so unreachable — but the column is
        // nullable and a cursor built from `null` would restart the walk.
        break;
      }
      after = { currentPeriodEnd: last.currentPeriodEnd, id: last.id };
      if (page.length < this.batchSize) break;
    }

    return result;
  }

  /**
   * One expiring membership. NEVER THROWS — a per-row failure lands on
   * `result.failed`, not on the pass, so a single bad row cannot strand every member
   * behind it in the page.
   */
  private async remindOne(
    row: UserSubscriptionRow,
    result: RemindExpiringMembershipResult
  ): Promise<void> {
    let claimed = false;
    const delivered: string[] = [];
    try {
      // RULE 1: the claim, before anything is read or sent.
      claimed = await this.reminders.claim(row.id);
      if (!claimed) {
        result.alreadyReminded += 1;
        return;
      }

      const subscriber = await this.users.findById(row.subscriberId);
      const owner = await this.users.findById(row.ownerId);
      if (subscriber === null || owner === null) {
        // Both are foreign keys, so this needs the database to have been edited by
        // hand. Failing loudly beats composing a message addressed to nobody.
        throw new Error(
          `membership ${row.id} names an app_user that is not there ` +
            `(subscriber ${subscriber === null ? "missing" : "found"}, ` +
            `owner ${owner === null ? "missing" : "found"})`
        );
      }

      // RULE 2. Which channels CAN deliver, decided once, before any of them is
      // tried — so "every channel failed" and "there was no channel" stay
      // distinguishable below.
      const channels: ("email" | "whatsapp")[] = [];
      if (this.email !== null) channels.push("email");
      if (this.notifier !== null && subscriber.whatsappNumber !== null) {
        channels.push("whatsapp");
      }

      if (channels.length === 0) {
        // RULE 3: the deliberate skip. Recorded in the database AND in the log.
        await this.reminders.recordOutcome({
          userSubscriptionId: row.id,
          outcome: MEMBERSHIP_REMINDER_NO_CHANNEL,
          channels: null,
        });
        // Fires on EVERY pass while the box stays broken, deliberately: this is an
        // alarm, not an audit entry, and an operator who has not configured email
        // should keep being told so until they have. The audit entry is the row, and
        // there is still only one of those per membership.
        this.logWarn(
          `[memberships] NO CHANNEL AVAILABLE for subscription=${row.id} — email ` +
            `${this.email !== null ? "configured" : "not configured on this box"}, whatsapp ` +
            `${subscriber.whatsappNumber !== null ? "on file" : "not on file"}. The member ` +
            `was NOT told their membership ends; recorded as ` +
            `membership_reminder.outcome='${MEMBERSHIP_REMINDER_NO_CHANNEL}', which a later ` +
            `pass WILL retry once a channel exists — configure email to fix this.`
        );
        result.skipped += 1;
        return;
      }

      const message = buildMembershipReminder({
        memberName: subscriber.displayName,
        ownerDisplayName: owner.displayName,
        ownerHandle: owner.handle,
        periodEnd: row.currentPeriodEnd,
        profileUrl: this.profileUrl(owner.handle),
      });
      const subject = buildMembershipReminderSubject(owner.handle);

      // RULE 4, second half: each channel in its own try/catch, so one provider being
      // down does not cost the member the other channel.
      for (const channel of channels) {
        try {
          if (channel === "email") {
            // Non-null whenever "email" is in `channels` — see where it is pushed.
            await (this.email as EmailProviderPort).send({
              to: subscriber.email,
              subject,
              body: message,
            });
          } else {
            await (this.notifier as MessagingProviderPort).notify({
              // Non-null whenever "whatsapp" is in `channels`, same reason.
              toWhatsappNumber: subscriber.whatsappNumber as string,
              message,
            });
          }
          delivered.push(channel);
        } catch (err) {
          // Counts and the channel name only — never the address, the number or the
          // body. A provider error can quote a URL, so it goes through the same
          // sanitiser every other worker-adjacent log line in this project uses.
          this.logError(
            `[memberships] subscription=${row.id} was NOT reminded over ${channel} — ` +
              `the send failed: ${redactLinks(safeErrorSummary(err))}`
          );
        }
      }

      if (delivered.length === 0) {
        // Every channel that existed threw. Nothing reached the member, so this is a
        // FAILURE and the catch below gives the claim back for the next pass.
        throw new Error(`every available channel (${channels.join(",")}) failed to deliver`);
      }

      await this.reminders.recordOutcome({
        userSubscriptionId: row.id,
        outcome: MEMBERSHIP_REMINDER_SENT,
        channels: delivered.join(","),
      });
      result.reminded += 1;
    } catch (err) {
      result.failed += 1;
      this.logError(
        `[memberships] subscription=${row.id} was NOT reminded: ` +
          `${redactLinks(safeErrorSummary(err))}`
      );
      // THE ONE PLACE THE CLAIM IS RELEASED, and only when NOTHING was delivered —
      // see the class docstring. A partial success keeps its claim, so the channel
      // that worked is never re-sent an hour later.
      if (claimed && delivered.length === 0) {
        try {
          await this.reminders.release(row.id);
        } catch (releaseErr) {
          // Best-effort: we are already handling a failure, and a second one here
          // must be visible rather than replace the first. The cost of not releasing
          // is one membership whose reminder is never retried, which the row's
          // `outcome='claimed'` still records.
          this.logError(
            `[memberships] subscription=${row.id}: the claim could NOT be released after a ` +
              `failed reminder, so no later pass will retry it — ` +
              `${redactLinks(safeErrorSummary(releaseErr))}`
          );
        }
      }
    }
  }

  /**
   * Where the member goes to buy again: the creator's own profile, where the tiers on
   * offer TODAY are listed and a fresh invoice is created.
   *
   * Deliberately not a link to an old invoice, and deliberately carrying no price: a
   * tier can be renamed, deactivated or repriced between this message and the member
   * acting on it, and a message quoting a number that no longer applies is worse than
   * one that quotes none.
   *
   * Mirrors `StartUserSubscription.subscriptionStatusUrl` in shape and in encoding —
   * the handle is generated by `domain/handle.ts` so it should never need escaping,
   * but this string is handed to a member who taps it, and that is not the place to
   * rely on an invariant held somewhere else.
   */
  private profileUrl(handle: string): string {
    return `${this.config.appBaseUrl}/@${encodeURIComponent(handle)}`;
  }
}

/** The Indonesian month names, for the end date in the message. */
const MONTHS_ID = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

/**
 * Asia/Jakarta is UTC+7 all year — Indonesia has never observed daylight saving — so
 * the WIB calendar day is readable by shifting the instant and taking its UTC parts.
 *
 * Done by hand rather than through `Intl.DateTimeFormat`, for the reason
 * `send-renewal-reminder.ts` gives for hand-rolling its rupiah formatter: the output
 * is asserted on in tests and read by members, and neither wants a value that varies
 * with the runtime's ICU build.
 */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** `2026-08-23T00:00Z` -> `"23 Agustus 2026"`, in WIB. */
function formatWibDate(at: Date): string {
  const wib = new Date(at.getTime() + WIB_OFFSET_MS);
  return `${wib.getUTCDate()} ${MONTHS_ID[wib.getUTCMonth()]} ${wib.getUTCFullYear()}`;
}

/** The subject line, in Indonesian. Exported for nothing — it belongs with the body. */
function buildMembershipReminderSubject(ownerHandle: string): string {
  return `Keanggotaan Anda untuk @${ownerHandle} akan segera berakhir`;
}

/**
 * The one message the member receives, identical over both channels. In Indonesian,
 * because members are — every member-facing string in this product is.
 *
 * Built in one place rather than assembled across the use-case for the same reason
 * `SendRenewalReminder`'s is: it is the entire member-visible surface of this feature,
 * and what may and may not appear in it is easier to check when it is all here.
 *
 * WHAT IS DELIBERATELY NOT IN IT: any amount, any tier name, and any promise that
 * something will renew. Nothing renews — saying so is the single most important thing
 * this message does, because a member who expects an automatic charge will not act.
 */
function buildMembershipReminder(input: {
  memberName: string;
  ownerDisplayName: string;
  ownerHandle: string;
  periodEnd: Date | null;
  profileUrl: string;
}): string {
  const lines = [
    input.memberName === "" ? "Halo!" : `Halo ${input.memberName},`,
    "",
  ];

  const creator = `${input.ownerDisplayName} (@${input.ownerHandle})`;
  if (input.periodEnd === null) {
    // Excluded by the query, so unreachable — the sentence stays honest anyway rather
    // than printing an Invalid Date at a member.
    lines.push(`Keanggotaan Anda untuk ${creator} akan segera berakhir.`);
  } else {
    lines.push(
      `Keanggotaan Anda untuk ${creator} akan berakhir pada ` +
        `${formatWibDate(input.periodEnd)}.`
    );
  }

  lines.push("");
  lines.push(
    "Tidak ada perpanjangan otomatis di DIUDARA — setelah tanggal tersebut, akses Anda " +
      "ke unggahan khusus anggota berhenti sampai Anda berlangganan lagi."
  );
  lines.push("");
  lines.push("Ingin melanjutkan? Buka halaman berikut dan pilih paket keanggotaan:");
  lines.push(input.profileUrl);
  lines.push("");
  lines.push("Terima kasih sudah mendukung karya di DIUDARA.");

  return lines.join("\n");
}
