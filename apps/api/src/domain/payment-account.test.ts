import { describe, expect, it } from "bun:test";
import {
  XENDIT_ACCOUNT_PROVISIONING,
  isConnectedPaymentAccount,
  isProvisioningPlaceholder,
} from "./payment-account";

describe("XENDIT_ACCOUNT_PROVISIONING", () => {
  it("is the literal StartCheckout's test refuses", () => {
    // start-checkout.test.ts hardcodes this string rather than importing it, on
    // purpose: a shared import would let the guard and the sentinel drift together
    // and both tests would stay green. This is the one place they are compared.
    expect(XENDIT_ACCOUNT_PROVISIONING).toBe("provisioning:in-progress");
  });

  it("could not be mistaken for a Xendit account id", () => {
    // Xendit account ids are 24-character hex object ids. A sentinel that looked
    // like one would be invisible in the table and, worse, plausible as a
    // `for_account_id`.
    expect(XENDIT_ACCOUNT_PROVISIONING).not.toMatch(/^[0-9a-f]{24}$/i);
    expect(XENDIT_ACCOUNT_PROVISIONING).toContain(":");
    // varchar(255).
    expect(XENDIT_ACCOUNT_PROVISIONING.length).toBeLessThan(255);
  });
});

describe("isProvisioningPlaceholder", () => {
  it("is true only for the sentinel", () => {
    expect(isProvisioningPlaceholder(XENDIT_ACCOUNT_PROVISIONING)).toBe(true);
    for (const value of [null, "", "provisioning", "PROVISIONING:IN-PROGRESS", "acct-1"]) {
      expect(isProvisioningPlaceholder(value)).toBe(false);
    }
  });
});

describe("isConnectedPaymentAccount", () => {
  it("refuses null, empty, and the sentinel", () => {
    // The sentinel is TRUTHY, which is the whole reason this function exists:
    // every reader of creator.xendit_account_id used `if (accountId)`.
    expect(XENDIT_ACCOUNT_PROVISIONING).toBeTruthy();
    expect(isConnectedPaymentAccount(null)).toBe(false);
    expect(isConnectedPaymentAccount("")).toBe(false);
    expect(isConnectedPaymentAccount(XENDIT_ACCOUNT_PROVISIONING)).toBe(false);
  });

  it("accepts a real account id", () => {
    expect(isConnectedPaymentAccount("64c9a1f2e4b0c8d9a1f2e4b0")).toBe(true);
    // The fake adapter's shape, which the whole test suite settles into.
    expect(isConnectedPaymentAccount("fake-acct-1-creator-1")).toBe(true);
  });
});
