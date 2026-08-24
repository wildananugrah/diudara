import { describe, expect, it } from "bun:test";
import {
  computeUserSubscriptionPeriodEnd,
  routeInvoiceExternalId,
  USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX,
  userSubscriptionExternalId,
  userTransactionIdFromExternalId,
} from "./user-payment";

/**
 * THE LITERAL, never the imported constant. The webhook routes on this exact
 * string, and it is the only thing that distinguishes an invoice of ours from
 * anything else arriving down a shared, public callback stream — a test that
 * compared the code against itself would stay green while the shape of every
 * invoice DIUDARA opens changed underneath it.
 */
const PREFIX = "usub_";

/** A transaction id has this shape in production: `user_transaction.id` is a uuid. */
const TRANSACTION_ID = "7c1a0d2e-6f3b-4a5c-8d9e-0f1a2b3c4d5e";

describe("userSubscriptionExternalId", () => {
  it("mints `usub_<transactionId>`", () => {
    expect(userSubscriptionExternalId(TRANSACTION_ID)).toBe(`usub_${TRANSACTION_ID}`);
  });

  it("exports the prefix the webhook routes on", () => {
    expect(USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX).toBe(PREFIX);
  });
});

describe("userTransactionIdFromExternalId", () => {
  it("reads back exactly what it minted", () => {
    expect(userTransactionIdFromExternalId(userSubscriptionExternalId(TRANSACTION_ID))).toBe(
      TRANSACTION_ID
    );
  });

  it("returns null for a BARE uuid — the shape retired community invoices carried, never a user subscription", () => {
    expect(userTransactionIdFromExternalId(TRANSACTION_ID)).toBeNull();
  });

  it("returns null for anything else, rather than guessing", () => {
    expect(userTransactionIdFromExternalId("")).toBeNull();
    expect(userTransactionIdFromExternalId("sub_1234")).toBeNull();
    // The prefix must be a PREFIX: finding it further along the string is not
    // a match, or an `external_id` minted by somebody else could impersonate one.
    expect(userTransactionIdFromExternalId(`inv-usub_${TRANSACTION_ID}`)).toBeNull();
  });
});

/**
 * The routing decision the webhook makes on a PUBLIC endpoint, before it touches
 * a database.
 *
 * ONE shape is ours and everything else is somebody else's invoice or a probe.
 * The literals here are deliberate: a `usub_` written out by hand, and a bare
 * uuid written out by hand, because the whole point is that these two strings
 * are told apart WITHOUT the code being asked to agree with itself.
 */
describe("routeInvoiceExternalId", () => {
  /**
   * THE SECOND WORLD IS GONE, AND THE RULE SURVIVES IT.
   *
   * A bare uuid was the community handler's own shape — `StartCheckout` put
   * `transaction.id` straight on the wire — and retire-telegram Task 5 deleted
   * that handler. There is now exactly ONE kind of invoice this codebase mints,
   * and the temptation the deletion creates is to read "not recognised" as "must
   * therefore be the one that is left". That would activate a membership against
   * a payment for something else.
   *
   * So a bare uuid is nobody's: it is not sliced, not guessed at, and above all
   * not handed to the surviving path. The literal is written out by hand for the
   * same reason the rest of this block's are.
   */
  it("calls a BARE uuid unknown — the retired community shape is nobody's now, not the survivor's", () => {
    expect(routeInvoiceExternalId(TRANSACTION_ID)).toEqual({ kind: "unknown" });
    expect(routeInvoiceExternalId("7c1a0d2e-6f3b-4a5c-8d9e-0f1a2b3c4d5e")).toEqual({
      kind: "unknown",
    });
  });

  it("routes `usub_<uuid>` to the USER handler, with the prefix stripped", () => {
    expect(routeInvoiceExternalId(`usub_${TRANSACTION_ID}`)).toEqual({
      kind: "user",
      transactionId: "7c1a0d2e-6f3b-4a5c-8d9e-0f1a2b3c4d5e",
    });
  });

  it("accepts an UPPERCASE uuid behind the prefix — Postgres does, so a miss must not be a shape error", () => {
    const upper = "7C1A0D2E-6F3B-4A5C-8D9E-0F1A2B3C4D5E";
    expect(routeInvoiceExternalId(`usub_${upper}`).kind).toBe("user");
    // And still not the other way round: case has nothing to do with whether a
    // BARE uuid is ours.
    expect(routeInvoiceExternalId(upper)).toEqual({ kind: "unknown" });
  });

  /**
   * THE 500 VECTOR. `userTransactionIdFromExternalId("usub_")` returns `""` and
   * `("usub_x")` returns `"x"`; Task 6's re-review measured both throwing at the
   * driver (`invalid input syntax for type uuid`). This endpoint is public, so a
   * throw is a 500 anybody holding the callback token can trigger at will.
   */
  it("refuses a `usub_` prefix with no uuid behind it, rather than handing junk to the driver", () => {
    expect(routeInvoiceExternalId("usub_")).toEqual({ kind: "unknown" });
    expect(routeInvoiceExternalId("usub_x")).toEqual({ kind: "unknown" });
    expect(routeInvoiceExternalId("usub_1 OR 1=1")).toEqual({ kind: "unknown" });
  });

  /**
   * The whole outcome set, in one place, so a future reader can see that "unknown"
   * is a real answer and not a leftover. `sub_1234` is the brief's own example: it
   * is a plausible `external_id` from some other system, it is not `usub_`-shaped,
   * and it must reach no lookup at all.
   */
  it("calls anything matching NEITHER shape unknown, rather than guessing a kind for it", () => {
    for (const junk of ["", "haxx", "1 OR 1=1", "0000", "inv_9f2", "sub_1234"]) {
      expect(routeInvoiceExternalId(junk)).toEqual({ kind: "unknown" });
    }
  });

  it("has exactly TWO outcomes, and never invents a third that resolves to the survivor", () => {
    // With one kind of invoice left, "user" and "unknown" are the entire answer
    // space. A `usub_` id is the ONLY thing that can produce a transaction id.
    const answers = [
      `usub_${TRANSACTION_ID}`,
      TRANSACTION_ID,
      "usub_",
      "sub_1234",
      "",
    ].map((id) => routeInvoiceExternalId(id));

    expect(answers.map((a) => a.kind)).toEqual(["user", "unknown", "unknown", "unknown", "unknown"]);
    expect(answers.filter((a) => a.kind === "user")).toHaveLength(1);
  });
});

/**
 * `user_subscription.current_period_end`, which is what Phase 6's paywall
 * compares against `now()`.
 */
describe("computeUserSubscriptionPeriodEnd", () => {
  it("adds one month for a monthly tier, keeping the time of day the member paid at", () => {
    expect(
      computeUserSubscriptionPeriodEnd(new Date("2026-08-09T11:00:00.000Z"), "monthly")
    ).toEqual(new Date("2026-09-09T11:00:00.000Z"));
  });

  it("adds three months for quarterly and twelve for yearly", () => {
    expect(
      computeUserSubscriptionPeriodEnd(new Date("2026-08-09T11:00:00.000Z"), "quarterly")
    ).toEqual(new Date("2026-11-09T11:00:00.000Z"));
    expect(
      computeUserSubscriptionPeriodEnd(new Date("2026-08-09T11:00:00.000Z"), "yearly")
    ).toEqual(new Date("2027-08-09T11:00:00.000Z"));
  });

  /**
   * `setMonth` OVERFLOWS — 31 January plus a month becomes 3 March — which would
   * hand a member two extra days of access every cycle. Reusing
   * `computeNextBillingDate` is what stops that being re-derived here.
   */
  it("clamps to the last day of a short month instead of overflowing into the next one", () => {
    expect(
      computeUserSubscriptionPeriodEnd(new Date("2026-01-31T08:30:00.000Z"), "monthly")
    ).toEqual(new Date("2026-02-28T08:30:00.000Z"));
    expect(
      computeUserSubscriptionPeriodEnd(new Date("2028-01-31T08:30:00.000Z"), "monthly")
    ).toEqual(new Date("2028-02-29T08:30:00.000Z"));
  });

  it("crosses a year boundary", () => {
    expect(
      computeUserSubscriptionPeriodEnd(new Date("2026-12-15T23:59:59.000Z"), "monthly")
    ).toEqual(new Date("2027-01-15T23:59:59.000Z"));
  });

  /**
   * `user_tier.billing_cycle` is a varchar, not an enum, so an unrecognised value
   * can physically reach here. Guessing "monthly" would sell a yearly member
   * eleven months of nothing.
   */
  it("throws on an unrecognised cycle rather than defaulting to one", () => {
    expect(() => computeUserSubscriptionPeriodEnd(new Date("2026-08-09T11:00:00Z"), "weekly")).toThrow(
      "unrecognised billing cycle"
    );
    expect(() => computeUserSubscriptionPeriodEnd(new Date("2026-08-09T11:00:00Z"), "")).toThrow(
      "unrecognised billing cycle"
    );
  });

  it("gives the member the FULL period they paid for, not a truncated calendar day", () => {
    // A period that ended at midnight UTC on the computed day would cut eleven
    // hours off a member who paid at 11:00, every single cycle.
    const paidAt = new Date("2026-08-09T11:00:00.000Z");
    const end = computeUserSubscriptionPeriodEnd(paidAt, "monthly");
    expect(end.getTime() - paidAt.getTime()).toBe(31 * 24 * 60 * 60 * 1000);
  });
});
