import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import AccountPage from "./AccountPage";
import { getPaymentAccountState, resetPaymentAccountCacheForTesting } from "../paymentAccount";
import { renderPage, stubFetch } from "../testing";

function render() {
  return renderPage(<AccountPage />, { path: "/dashboard/account", at: "/dashboard/account" });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
  resetPaymentAccountCacheForTesting();
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("AccountPage", () => {
  it("explains that without a payment account nobody can buy anything", async () => {
    stubFetch([{ path: "/payment-account", body: { connected: false, provisioning: false } }]);
    render();

    expect(screen.getByText(/tidak ada yang bisa membeli|tidak bisa menerima pembayaran/)).toBeTruthy();

    // Let the mount's own GET resolve inside `act` rather than after the test ends.
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("connects payments and reports success", async () => {
    const stub = stubFetch([
      { path: "/payment-account", body: { connected: false, provisioning: false } },
      { method: "POST", path: "/payment-account", status: 201, body: { xenditAccountId: "acct-123" } },
    ]);

    render();
    fireEvent.click(screen.getByRole("button", { name: /Hubungkan pembayaran/ }));

    expect(await screen.findByText(/Pembayaran terhubung/)).toBeTruthy();
    const post = stub.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/payment-account");
    // Remembered in memory, so the warning on the other screens goes away —
    // see paymentAccount.ts. No longer localStorage: the server is now the
    // source of truth, and this is just this tab's cache of its answer.
    expect(getPaymentAccountState()).toBe("connected");
  });

  it("treats a 409 'already connected' as connected rather than as a failure", async () => {
    stubFetch([
      { path: "/payment-account", body: { connected: false, provisioning: false } },
      {
        method: "POST",
        path: "/payment-account",
        status: 409,
        body: { error: "payment account already connected" },
      },
    ]);

    render();
    fireEvent.click(screen.getByRole("button", { name: /Hubungkan pembayaran/ }));

    expect(await screen.findByText(/sudah terhubung/)).toBeTruthy();
    await waitFor(() => expect(getPaymentAccountState()).toBe("connected"));
  });

  it("reports a 409 'in progress' as in progress, and does NOT call it connected", async () => {
    stubFetch([
      { path: "/payment-account", body: { connected: false, provisioning: false } },
      {
        method: "POST",
        path: "/payment-account",
        status: 409,
        body: { error: "a payment account connection is already in progress" },
      },
    ]);

    render();
    fireEvent.click(screen.getByRole("button", { name: /Hubungkan pembayaran/ }));

    expect(await screen.findByText(/sedang diproses/)).toBeTruthy();
    expect(getPaymentAccountState()).not.toBe("connected");
    expect(getPaymentAccountState()).toBe("provisioning");
  });

  it("renders any other failure inline and lets the creator try again", async () => {
    stubFetch([
      { path: "/payment-account", body: { connected: false, provisioning: false } },
      { method: "POST", path: "/payment-account", status: 500, body: { error: "internal server error" } },
    ]);

    render();
    fireEvent.click(screen.getByRole("button", { name: /Hubungkan pembayaran/ }));

    expect(await screen.findByText(/internal server error/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Hubungkan pembayaran/ })).toBeTruthy();
    expect(getPaymentAccountState()).not.toBe("connected");
  });

  it("shows who is signed in without ever showing the token", async () => {
    stubFetch([{ path: "/payment-account", body: { connected: false, provisioning: false } }]);
    render();

    expect(screen.getByText("budi@example.com")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("jwt-test");

    await act(async () => {
      await Promise.resolve();
    });
  });
});
