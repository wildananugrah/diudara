import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import AccountPage from "./AccountPage";
import { renderPage, stubFetch } from "../testing";

function render() {
  return renderPage(<AccountPage />, { path: "/dashboard/account", at: "/dashboard/account" });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("AccountPage", () => {
  it("explains that without a payment account nobody can buy anything", () => {
    stubFetch([]);
    render();

    expect(screen.getByText(/tidak ada yang bisa membeli|tidak bisa menerima pembayaran/)).toBeTruthy();
  });

  it("connects payments and reports success", async () => {
    const stub = stubFetch([
      { method: "POST", path: "/payment-account", status: 201, body: { xenditAccountId: "acct-123" } },
    ]);

    render();
    fireEvent.click(screen.getByRole("button", { name: /Hubungkan pembayaran/ }));

    expect(await screen.findByText(/Pembayaran terhubung/)).toBeTruthy();
    expect(stub.calls[0]!.url).toBe("/payment-account");
    expect(stub.calls[0]!.method).toBe("POST");
    // Remembered, so the warning on the other screens goes away.
    expect(localStorage.getItem("diudara.dashboard.payments.creator-1")).toBe("connected");
  });

  it("treats a 409 'already connected' as connected rather than as a failure", async () => {
    stubFetch([
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
    await waitFor(() =>
      expect(localStorage.getItem("diudara.dashboard.payments.creator-1")).toBe("connected")
    );
  });

  it("reports a 409 'in progress' as in progress, and does NOT call it connected", async () => {
    stubFetch([
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
    expect(localStorage.getItem("diudara.dashboard.payments.creator-1")).not.toBe("connected");
  });

  it("renders any other failure inline and lets the creator try again", async () => {
    stubFetch([
      { method: "POST", path: "/payment-account", status: 500, body: { error: "internal server error" } },
    ]);

    render();
    fireEvent.click(screen.getByRole("button", { name: /Hubungkan pembayaran/ }));

    expect(await screen.findByText(/internal server error/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Hubungkan pembayaran/ })).toBeTruthy();
    expect(localStorage.getItem("diudara.dashboard.payments.creator-1")).toBeNull();
  });

  it("shows who is signed in without ever showing the token", () => {
    stubFetch([]);
    render();

    expect(screen.getByText("budi@example.com")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("jwt-test");
  });
});
