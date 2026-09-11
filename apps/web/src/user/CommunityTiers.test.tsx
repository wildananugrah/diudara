import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CommunityTiers from "./CommunityTiers";
import type { CommunityTierRow } from "./apiClient";

/**
 * **No happy-dom node ever reaches a serialising matcher** (see
 * `no-hanging-dom-assertions.test.ts`): negatives are `queryAllBy…().length`,
 * values are `.textContent` / `.getAttribute(...)` / arrays of strings.
 */

function aTier(overrides: Partial<CommunityTierRow> = {}): CommunityTierRow {
  return {
    id: "tier-1",
    name: "Premium",
    priceAmount: 99_000,
    billingCycle: "monthly",
    isActive: true,
    ...overrides,
  };
}

let originalFetch: typeof fetch;
let originalConfirm: typeof window.confirm;

beforeEach(() => {
  originalFetch = global.fetch;
  originalConfirm = window.confirm;
});

afterEach(() => {
  global.fetch = originalFetch;
  window.confirm = originalConfirm;
  cleanup();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(
  options: { tiers?: CommunityTierRow[]; status?: number; subscribe?: unknown } = {}
): string[] {
  const calls: string[] = [];
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/subscribe")) {
      return jsonResponse(options.subscribe ?? { subscriptionId: "sub-1" }, 201);
    }
    if (init?.method === "POST") return jsonResponse(aTier({ id: "tier-new", name: "Baru" }), 201);
    if (init?.method === "PATCH") return jsonResponse(aTier({ isActive: false }));
    if (options.status !== undefined && options.status !== 200) {
      return jsonResponse({ error: "boom" }, options.status);
    }
    return jsonResponse({ tiers: options.tiers ?? [aTier()] });
  }) as unknown as typeof fetch;
  return calls;
}

function renderTiers(props: { viewerIsOwner?: boolean; viewerIsMember?: boolean | null } = {}) {
  return render(
    <MemoryRouter>
      <CommunityTiers
        slug="kelas-fisika"
        viewerIsOwner={props.viewerIsOwner ?? false}
        // `in`, NOT `??` — `viewerIsMember` is three-state and `?? false`
        // turns an explicitly passed `null` into `false`, which would test
        // the signed-in non-member case every time a signed-out one was meant.
        viewerIsMember={"viewerIsMember" in props ? (props.viewerIsMember ?? null) : false}
      />
    </MemoryRouter>
  );
}

describe("CommunityTiers", () => {
  it("shows the offer to anyone, with the price in rupiah", async () => {
    stubFetch();
    renderTiers({ viewerIsMember: null });

    await screen.findByText("Premium");
    // Open reading: a price nobody can see is not an offer, and a paid
    // community has to be evaluable before joining.
    expect(screen.getByText(/99\.000/).textContent).toContain("99.000");
  });

  it("calls a zero-price tier free rather than Rp 0", async () => {
    stubFetch({ tiers: [aTier({ priceAmount: 0 })] });
    renderTiers({ viewerIsMember: true });

    await screen.findByText("Gratis");
  });

  it("a member gets a real choose button", async () => {
    const calls = stubFetch();
    renderTiers({ viewerIsMember: true });

    fireEvent.click(await screen.findByRole("button", { name: "Pilih" }));

    await waitFor(() => expect(calls.some((call) => call.includes("/subscribe"))).toBe(true));
  });

  /**
   * The server requires membership before checkout, so a button here would be
   * a control for an action that 403s — the rule Phase 1 set when it cut the
   * tab bar. The copy differs per state because signing in and joining are
   * different actions.
   */
  it.each([
    ["a signed-in non-member", false as boolean | null, "Gabung dulu"],
    ["a signed-out visitor", null as boolean | null, "Masuk untuk berlangganan"],
  ])("shows %s a pointer, not a button", async (_label, viewerIsMember, expected) => {
    stubFetch();
    renderTiers({ viewerIsMember });

    await screen.findByText("Premium");
    expect(screen.queryAllByRole("button", { name: "Pilih" }).length).toBe(0);
    expect(screen.getByText(expected).textContent).toBe(expected);
  });

  it("the owner manages rather than buys", async () => {
    stubFetch();
    renderTiers({ viewerIsOwner: true, viewerIsMember: true });

    await screen.findByText("Premium");
    // An owner cannot subscribe to their own tier — `user_subscription_no_self`
    // forbids the row — so offering them the button would be offering a 500.
    expect(screen.queryAllByRole("button", { name: "Pilih" }).length).toBe(0);
    expect(screen.getAllByRole("button", { name: "Nonaktifkan" }).length).toBe(1);
  });

  it("the owner adds a tier, and it joins the offer without a refetch", async () => {
    const calls = stubFetch();
    renderTiers({ viewerIsOwner: true, viewerIsMember: true });
    await screen.findByText("Premium");

    fireEvent.change(screen.getByLabelText("Nama tingkatan"), { target: { value: "Baru" } });
    fireEvent.change(screen.getByLabelText("Harga per bulan (Rp)"), { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("button", { name: "Tambah tingkatan" }));

    await screen.findByText("Baru");
    expect(calls.filter((call) => call.startsWith("GET")).length).toBe(1);
  });

  it("will not submit an unnamed tier", async () => {
    stubFetch();
    renderTiers({ viewerIsOwner: true, viewerIsMember: true });
    await screen.findByText("Premium");

    const submit = screen.getByRole("button", { name: "Tambah tingkatan" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("deactivating asks first, and a cancel changes nothing", async () => {
    window.confirm = mock(() => false) as unknown as typeof window.confirm;
    const calls = stubFetch();
    renderTiers({ viewerIsOwner: true, viewerIsMember: true });
    await screen.findByText("Premium");

    fireEvent.click(screen.getByRole("button", { name: "Nonaktifkan" }));

    expect(calls.filter((call) => call.startsWith("PATCH")).length).toBe(0);
    expect(screen.queryAllByText("Premium").length).toBe(1);
  });

  it("a confirmed deactivation removes it from the offer", async () => {
    window.confirm = mock(() => true) as unknown as typeof window.confirm;
    stubFetch();
    renderTiers({ viewerIsOwner: true, viewerIsMember: true });
    await screen.findByText("Premium");

    fireEvent.click(screen.getByRole("button", { name: "Nonaktifkan" }));

    await waitFor(() => expect(screen.queryAllByText("Premium").length).toBe(0));
  });

  it("an empty offer says so", async () => {
    stubFetch({ tiers: [] });
    renderTiers({ viewerIsMember: true });

    await screen.findByText(/Belum ada tingkatan/);
  });

  it("a failed load shows an error, not an empty offer", async () => {
    stubFetch({ status: 500 });
    renderTiers({ viewerIsMember: true });

    await screen.findByRole("alert");
    expect(screen.queryAllByText(/Belum ada tingkatan/).length).toBe(0);
  });
});
