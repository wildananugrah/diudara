import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { setSession } from "./auth";
import { recordPaymentAccountState } from "./paymentAccount";
import { PaymentAccountNotice } from "./ui";

const CREATOR = { id: "creator-1", name: "Budi", email: "budi@example.com" };

beforeEach(() => {
  localStorage.clear();
  setSession("jwt-test", CREATOR);
});

afterEach(cleanup);

/** The notice needs a router, because it links to the account screen. */
function mount(count: number) {
  return render(
    <MemoryRouter>
      {Array.from({ length: count }, (_, index) => (
        <PaymentAccountNotice key={index} />
      ))}
    </MemoryRouter>
  );
}

describe("PaymentAccountNotice", () => {
  it("warns while this browser has no confirmation that payments are connected", () => {
    mount(1);
    expect(screen.getAllByTestId("payment-account-notice").length).toBe(1);
  });

  it("CLEARS ITSELF THE MOMENT PAYMENTS CONNECT, with no navigation in between", () => {
    // It read `localStorage` during render and subscribed to nothing, so it only
    // noticed a connected account when something else happened to re-render it.
    // In practice that meant a creator pressed "Hubungkan pembayaran", the account
    // screen went green, and every other mounted screen carried on telling them
    // nobody could buy anything until they navigated.
    mount(1);
    expect(screen.getAllByTestId("payment-account-notice").length).toBe(1);

    act(() => {
      recordPaymentAccountState("connected");
    });

    expect(screen.queryAllByTestId("payment-account-notice").length).toBe(0);
  });

  it("clears EVERY mounted copy, not just the one nearest the action", () => {
    // Two screens can hold the notice at once (the communities list and the tier
    // editor both render it), and a per-instance fix would leave the other lying.
    mount(2);
    expect(screen.getAllByTestId("payment-account-notice").length).toBe(2);

    act(() => {
      recordPaymentAccountState("connected");
    });

    expect(screen.queryAllByTestId("payment-account-notice").length).toBe(0);
  });

  it("re-arms when the recorded state is withdrawn, rather than latching off", () => {
    // A subscription that only ever fires in one direction is a cache, not a
    // subscription — and this warning failing OPEN is the safe direction.
    recordPaymentAccountState("connected");
    mount(1);
    expect(screen.queryAllByTestId("payment-account-notice").length).toBe(0);

    act(() => {
      recordPaymentAccountState("unknown");
    });

    expect(screen.getAllByTestId("payment-account-notice").length).toBe(1);
  });

  it("says 'sedang diproses' rather than 'belum terhubung' for an in-progress account", () => {
    mount(1);

    act(() => {
      recordPaymentAccountState("in_progress");
    });

    const notice = screen.getByTestId("payment-account-notice").textContent ?? "";
    expect(notice).toMatch(/sedang diproses/);
  });
});
