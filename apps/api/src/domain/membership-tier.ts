export type BillingCycle = "monthly" | "quarterly" | "yearly";

export interface MembershipTier {
  id: string;
  communityId: string;
  name: string;
  priceAmount: number;
  billingCycle: BillingCycle;
  isActive: boolean;
}

const VALID_BILLING_CYCLES: BillingCycle[] = ["monthly", "quarterly", "yearly"];

export function createMembershipTier(input: {
  id: string;
  communityId: string;
  name: string;
  priceAmount: number;
  billingCycle: BillingCycle;
  isActive?: boolean;
}): MembershipTier {
  if (input.priceAmount < 0) {
    throw new Error("priceAmount must not be negative");
  }
  if (!VALID_BILLING_CYCLES.includes(input.billingCycle)) {
    throw new Error(`billingCycle must be one of ${VALID_BILLING_CYCLES.join(", ")}`);
  }
  if (input.name.trim().length === 0) {
    throw new Error("name must not be empty");
  }

  return {
    id: input.id,
    communityId: input.communityId,
    name: input.name,
    priceAmount: input.priceAmount,
    billingCycle: input.billingCycle,
    isActive: input.isActive ?? true,
  };
}

export function assertValidTier(input: {
  name: string;
  priceAmount: number;
  billingCycle: BillingCycle;
}): void {
  if (input.priceAmount < 0) {
    throw new Error("priceAmount must not be negative");
  }
  if (!VALID_BILLING_CYCLES.includes(input.billingCycle)) {
    throw new Error(`billingCycle must be one of ${VALID_BILLING_CYCLES.join(", ")}`);
  }
  if (input.name.trim().length === 0) {
    throw new Error("name must not be empty");
  }
}
