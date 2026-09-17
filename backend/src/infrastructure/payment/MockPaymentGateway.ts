import type { PaymentGateway } from "../../domain/ports.ts";
import type { PaymentStatus } from "../../domain/types.ts";

/**
 * Confirms every charge immediately, which is exactly what Checkout.tsx depicts
 * (its "Bayar" button jumps straight to the success step).
 *
 * This is the ONLY place that simulation lives. A real gateway implements the
 * same `charge` and returns status "pending" plus a redirectUrl; the checkout
 * service and its callers stay untouched, and POST /api/webhooks/payment already
 * exists to receive the async confirmation.
 */
export class MockPaymentGateway implements PaymentGateway {
  async charge(input: { amountCents: number; method: string; reference: string }): Promise<{
    gatewayRef: string; status: PaymentStatus; redirectUrl: string | null;
  }> {
    return {
      gatewayRef: `mock_${input.reference}_${Date.now()}`,
      status: "paid",
      redirectUrl: null,
    };
  }
}
