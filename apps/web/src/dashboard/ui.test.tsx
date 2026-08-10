import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { setSession } from "./auth";
import { recordPaymentAccountState, resetPaymentAccountCacheForTesting } from "./paymentAccount";
import { stubFetch } from "./testing";
import { AiCoBuilderNavLink, PaymentAccountNotice } from "./ui";

const CREATOR = { id: "creator-1", name: "Budi", email: "budi@example.com" };

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
  setSession("jwt-test", CREATOR);
  resetPaymentAccountCacheForTesting();
  // Every mount kicks off `GET /payment-account` — see PaymentAccountNotice's
  // docstring. Most of these tests drive the notice with
  // `recordPaymentAccountState` directly instead of waiting on this fetch, so
  // the default answer barely matters; it only has to exist so the request
  // does not go unstubbed.
  stubFetch([{ path: "/payment-account", body: { connected: false, provisioning: false } }]);
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

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
  it("warns while nothing has confirmed that payments are connected", async () => {
    mount(1);
    expect(screen.getAllByTestId("payment-account-notice").length).toBe(1);

    // Let the mount's own `GET /payment-account` resolve before the test ends,
    // so its state update (to the same "not connected" answer, in this case)
    // happens inside `act` rather than bleeding into whatever runs next.
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("CLEARS ITSELF THE MOMENT PAYMENTS CONNECT, with no navigation in between", () => {
    // It used to read `localStorage` during render and subscribe to nothing, so
    // it only noticed a connected account when something else happened to
    // re-render it. In practice that meant a creator pressed "Hubungkan
    // pembayaran", the account screen went green, and every other mounted
    // screen carried on telling them nobody could buy anything until they
    // navigated.
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
      recordPaymentAccountState("not_connected");
    });

    expect(screen.getAllByTestId("payment-account-notice").length).toBe(1);
  });

  it("says 'sedang diproses' rather than 'belum terhubung' for an in-progress account", () => {
    mount(1);

    act(() => {
      recordPaymentAccountState("provisioning");
    });

    const notice = screen.getByTestId("payment-account-notice").textContent ?? "";
    expect(notice).toMatch(/sedang diproses/);
  });
});

describe("AiCoBuilderNavLink", () => {
  function mountNav() {
    return render(
      <MemoryRouter>
        <AiCoBuilderNavLink />
      </MemoryRouter>
    );
  }

  it("renders nothing while GET /ai/status has not answered yet", () => {
    stubFetch([{ path: "/ai/status", body: { enabled: true } }]);
    mountNav();
    // Fails toward HIDING: before the fetch resolves, there is nothing to click.
    expect(screen.queryAllByText("AI Co-Builder").length).toBe(0);
  });

  it("shows the link once the server confirms the feature is enabled", async () => {
    stubFetch([{ path: "/ai/status", body: { enabled: true } }]);
    mountNav();
    expect(await screen.findByText("AI Co-Builder")).toBeTruthy();
  });

  it("stays hidden when the server reports the feature disabled", async () => {
    stubFetch([{ path: "/ai/status", body: { enabled: false } }]);
    mountNav();
    await waitFor(() => expect(screen.queryAllByText("AI Co-Builder").length).toBe(0));
  });

  it("fails toward hiding rather than showing a link that can only ever error", async () => {
    // GET /ai/status itself failing (a 500, a network error) must not show
    // the link — the whole point is never reaching POST /ai/messages on a
    // box that cannot serve it.
    stubFetch([{ path: "/ai/status", status: 500, body: { error: "internal server error" } }]);
    mountNav();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryAllByText("AI Co-Builder").length).toBe(0);
  });
});
