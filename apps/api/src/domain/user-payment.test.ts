import { describe, expect, it } from "bun:test";
import {
  USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX,
  userSubscriptionExternalId,
  userTransactionIdFromExternalId,
} from "./user-payment";

/**
 * THE LITERAL, never the imported constant. Task 7's webhook routes on this
 * exact string and the community handler's invoices carry no prefix at all —
 * a test that compared the code against itself would stay green while the
 * shape of every invoice DIUDARA opens changed underneath it.
 */
const PREFIX = "usub_";

/** A transaction id has this shape in production: `user_transaction.id` is a uuid. */
const TRANSACTION_ID = "7c1a0d2e-6f3b-4a5c-8d9e-0f1a2b3c4d5e";

describe("userSubscriptionExternalId", () => {
  it("mints `usub_<transactionId>`", () => {
    expect(userSubscriptionExternalId(TRANSACTION_ID)).toBe(`usub_${TRANSACTION_ID}`);
  });

  it("exports the prefix Task 7 routes on", () => {
    expect(USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX).toBe(PREFIX);
  });
});

describe("userTransactionIdFromExternalId", () => {
  it("reads back exactly what it minted", () => {
    expect(userTransactionIdFromExternalId(userSubscriptionExternalId(TRANSACTION_ID))).toBe(
      TRANSACTION_ID
    );
  });

  it("returns null for a BARE uuid — the community handler's own shape, never a user subscription", () => {
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
