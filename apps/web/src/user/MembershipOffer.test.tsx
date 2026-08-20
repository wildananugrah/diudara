import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import MembershipOffer from "./MembershipOffer";
import { getUserToken, setUserSession, type TierView } from "./apiClient";

const VIEWER = { handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };
const OWNER = { handle: "budi", displayName: "Budi", email: "budi@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tier(overrides: Partial<TierView> = {}): TierView {
  return {
    id: "tier-1",
    name: "Anggota",
    priceAmount: 50000,
    billingCycle: "monthly",
    ...overrides,
  };
}

/**
 * Stands in for `LoginPage`, and ACTUALLY reads `location.state.from` — the
 * same shape `SettingsPage.test.tsx` uses for the same reason: a stub that
 * only proved "some page was reached" would stay green if the offer sent a
 * signed-out visitor to Masuk with no way back to the profile they were
 * standing on.
 */
function MasukStub() {
  const location = useLocation();
  const state = location.state as { from?: unknown } | null;
  return (
    <div data-testid="masuk">
      Masuk{typeof state?.from === "string" ? ` — kembali ke ${state.from}` : ""}
    </div>
  );
}

function renderOffer(tiers: TierView[], handle = "budi") {
  return render(
    <MemoryRouter initialEntries={[`/@${handle}`]}>
      <Routes>
        <Route path="/:handleParam" element={<MembershipOffer handle={handle} tiers={tiers} />} />
        <Route path="/masuk" element={<MasukStub />} />
      </Routes>
    </MemoryRouter>
  );
}

let originalFetch: typeof fetch;
let originalHref: PropertyDescriptor | undefined;
/** Every `window.location.href = ...` the component performed, in order. */
let followed: string[];

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
  followed = [];
  // Assigning `window.location.href` in happy-dom would try to navigate the
  // test document ("navigation not implemented"); the same stub
  // `CheckoutPage.test.tsx` uses, except that this one RECORDS, because
  // following the invoice url is the behaviour under test rather than an
  // accident to be silenced.
  originalHref = Object.getOwnPropertyDescriptor(window.location, "href");
  Object.defineProperty(window.location, "href", {
    configurable: true,
    set: (value: string) => {
      followed.push(value);
    },
    get: () => "about:blank",
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalHref) Object.defineProperty(window.location, "href", originalHref);
  cleanup();
});

describe("MembershipOffer — what a creator is selling (spec §6)", () => {
  it("shows every active tier with its price the way an Indonesian reads rupiah", () => {
    setUserSession("jwt-abc", VIEWER);
    renderOffer([
      tier(),
      tier({ id: "tier-2", name: "Anggota Plus", priceAmount: 125000 }),
    ]);

    const first = screen.getByTestId("membership-tier-tier-1");
    expect(first.textContent).toContain("Anggota");
    // The separator is a DOT, not a comma, and there is no ",00" — id-ID.
    expect(first.textContent).toContain("Rp 50.000");
    expect(first.textContent).toContain("per bulan");

    const second = screen.getByTestId("membership-tier-tier-2");
    expect(second.textContent).toContain("Anggota Plus");
    expect(second.textContent).toContain("Rp 125.000");
  });

  /**
   * A billing cycle this app has no word for is still a tier somebody is
   * selling. `user_tier.billing_cycle` is a varchar precisely so 5b can add
   * values without a migration (spec §4), so an unknown one passes through
   * rather than rendering as nothing at all.
   */
  it("passes an unknown billing cycle through instead of hiding it", () => {
    setUserSession("jwt-abc", VIEWER);
    renderOffer([tier({ billingCycle: "yearly" })]);

    expect(screen.getByTestId("membership-tier-tier-1").textContent).toContain("yearly");
  });

  /**
   * NOT an empty box, NOT a heading standing over nothing. A creator who
   * sells nothing has no offer, and `membership: { tiers: [] }` is what the
   * API reports for one (`toMembershipView`) — most profiles in this app.
   */
  it("renders nothing at all — no heading, no box — for a profile that sells nothing", () => {
    setUserSession("jwt-abc", VIEWER);
    renderOffer([]);

    expect(document.body.textContent).toBe("");
    expect(document.querySelectorAll(".membership-offer").length).toBe(0);
    expect(screen.queryAllByRole("heading").length).toBe(0);
    expect(screen.queryAllByRole("button").length).toBe(0);
    expect(screen.queryAllByRole("link").length).toBe(0);
  });
});

describe("MembershipOffer — a signed-out visitor goes to Masuk, never to a failed request", () => {
  it("offers Masuk instead of the buy button, and reaches Masuk carrying the profile to return to", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ error: "must not be called" }, 401);
    }) as unknown as typeof fetch;

    renderOffer([tier()]);

    expect(screen.queryAllByRole("button", { name: /Jadi anggota/ }).length).toBe(0);
    fireEvent.click(screen.getByRole("link", { name: "Masuk untuk jadi anggota" }));

    const masuk = await screen.findByTestId("masuk");
    expect(masuk.textContent).toContain("kembali ke /@budi");
    // Spec §6: buying is signed-in only. The visitor is routed BEFORE any
    // request, not after a 401 — nothing was ever sent.
    expect(calls.length).toBe(0);
  });
});

describe("MembershipOffer — pressing Jadi anggota", () => {
  it("POSTs the chosen tier to /users/:handle/subscribe and follows the invoice url", async () => {
    setUserSession("jwt-abc", VIEWER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(
        {
          invoiceUrl: "https://checkout.xendit.co/web/inv_1",
          subscriptionId: "sub-1",
          transactionId: "txn-1",
          externalId: "usub_txn-1",
        },
        201
      );
    }) as unknown as typeof fetch;

    // TWO tiers, and the SECOND is pressed: a component that always sent
    // `tiers[0]` would charge this buyer for a membership they did not choose,
    // and a single-tier fixture cannot see that.
    renderOffer([tier(), tier({ id: "tier-2", name: "Anggota Plus", priceAmount: 125000 })]);
    fireEvent.click(screen.getByRole("button", { name: "Jadi anggota — Anggota Plus" }));

    await waitFor(() => {
      expect(followed.length).toBe(1);
    });
    expect(followed[0]).toBe("https://checkout.xendit.co/web/inv_1");
    expect(calls[0]!.url).toBe("/users/budi/subscribe");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ tierId: "tier-2" });
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
  });

  /**
   * A double tap on a phone is not a rare event, and `StartUserSubscription`
   * exists to make sure it cannot mint two invoices. That guard is the
   * server's; this is the client's half of it — the button stops being
   * pressable the moment the first request is in flight, and says why.
   */
  it("sends ONE request for a double tap, and says what it is doing while it waits", async () => {
    setUserSession("jwt-abc", VIEWER);
    const calls: string[] = [];
    // The codebase's own deferred-fetch shape (`FollowButton.test.tsx`): a
    // plain function, never a nullable one, so nothing has to be narrowed
    // back to callable at the point it is released.
    let releaseFetch: (res: Response) => void = () => {};
    global.fetch = mock((url: string) => {
      calls.push(url);
      return new Promise<Response>((resolve) => {
        releaseFetch = resolve;
      });
    }) as unknown as typeof fetch;

    renderOffer([tier()]);
    const button = screen.getByRole("button", { name: "Jadi anggota — Anggota" });
    fireEvent.click(button);

    await waitFor(() => {
      expect((screen.getByRole("button", { name: /Anggota/ }) as HTMLButtonElement).disabled).toBe(
        true
      );
    });
    expect(screen.getByRole("button", { name: /Anggota/ }).textContent).toContain(
      "Menyiapkan pembayaran"
    );

    fireEvent.click(screen.getByRole("button", { name: /Anggota/ }));
    expect(calls.length).toBe(1);

    releaseFetch(jsonResponse({ invoiceUrl: "https://checkout.xendit.co/web/inv_1" }, 201));
    await waitFor(() => {
      expect(followed.length).toBe(1);
    });
  });
});

describe("MembershipOffer — your own profile never offers you your own membership", () => {
  it("renders nothing at all when the viewer IS the creator", () => {
    setUserSession("jwt-abc", OWNER);
    renderOffer([tier()], "budi");

    // The server refuses it (`StartUserSubscription`'s self-subscribe 409) and
    // `user_subscription_no_self` forbids the row, so an offer here could only
    // ever collect a refusal.
    expect(document.body.textContent).toBe("");
    expect(screen.queryAllByRole("button").length).toBe(0);
    expect(screen.queryAllByRole("link").length).toBe(0);
  });

  /** PRESENCE control: the very same tier IS offered to somebody else. */
  it("offers that same tier to a different signed-in viewer", () => {
    setUserSession("jwt-abc", VIEWER);
    renderOffer([tier()], "budi");

    expect(screen.getByRole("button", { name: "Jadi anggota — Anggota" })).toBeTruthy();
  });

  it("is absent on your own profile regardless of handle case, on either side", () => {
    setUserSession("jwt-abc", { ...OWNER, handle: "BUDI" });
    renderOffer([tier()], "budi");

    expect(screen.queryAllByRole("button").length).toBe(0);
  });
});

describe("MembershipOffer — a failure is a Bahasa sentence, never the server's own string", () => {
  it("says the purchase could not be started, in Bahasa, for a 500", async () => {
    setUserSession("jwt-abc", VIEWER);
    global.fetch = mock(async () =>
      jsonResponse({ error: "internal server error" }, 500)
    ) as unknown as typeof fetch;

    renderOffer([tier()]);
    fireEvent.click(screen.getByRole("button", { name: "Jadi anggota — Anggota" }));

    // The whole alert's TEXT, in both directions: an exact-string negative
    // cannot see the server's sentence when a screen appends it to its own,
    // which is the precise shape this rule keeps being broken in (Task 9's
    // measurement, and `FollowButton.test.tsx:233`).
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Gagal memulai pembayaran keanggotaan.");
    expect(alert.textContent).toContain("Server sedang bermasalah");
    expect(alert.textContent).not.toContain("internal server error");
    // Nothing was followed, and the button is pressable again.
    expect(followed.length).toBe(0);
    expect(
      (screen.getByRole("button", { name: "Jadi anggota — Anggota" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  /**
   * The 409 is the refusal a retry cannot fix — the tier was withdrawn, the
   * creator's payout account is not ready, or this buyer already holds a live
   * membership or a live invoice. "Coba lagi" would send them round a loop
   * that cannot terminate, which is the same defect `describeUploadFailure`
   * was written to remove for HEIC photos.
   */
  it("tells a 409 to reload the profile rather than to try again", async () => {
    setUserSession("jwt-abc", VIEWER);
    global.fetch = mock(async () =>
      jsonResponse(
        {
          error:
            "Anda sudah menjadi anggota aktif kreator ini. Membayar lagi tidak menambah masa aktif — jika Anda belum bisa melihat kontennya, hubungi kreator tersebut.",
        },
        409
      )
    ) as unknown as typeof fetch;

    renderOffer([tier()]);
    fireEvent.click(screen.getByRole("button", { name: "Jadi anggota — Anggota" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Muat ulang halaman ini");
    expect(alert.textContent).not.toContain("Coba lagi");
    // The wire's own sentence is Bahasa here, and it is STILL not what a
    // screen prints — `src/test/no-raw-server-errors.test.ts`.
    expect(alert.textContent).not.toContain("Membayar lagi tidak menambah masa aktif");
  });

  it("says Bahasa for a dropped connection too, never the browser's 'Failed to fetch'", async () => {
    setUserSession("jwt-abc", VIEWER);
    global.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    renderOffer([tier()]);
    fireEvent.click(screen.getByRole("button", { name: "Jadi anggota — Anggota" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Tidak dapat menghubungi server");
    expect(alert.textContent).not.toContain("Failed to fetch");
  });

  /**
   * The one failure with a remedy that is not a sentence. `apiRequest` has
   * ALREADY cleared the token by the time this is caught (its own docstring),
   * so the buyer is now signed out standing in front of a signed-in-only
   * action — exactly `FollowButton`'s reasoning, and the same destination.
   */
  it("sends a buyer whose session expired mid-purchase to Masuk, carrying the profile to return to", async () => {
    setUserSession("jwt-abc", VIEWER);
    global.fetch = mock(async () =>
      jsonResponse({ error: "invalid or expired token" }, 401)
    ) as unknown as typeof fetch;

    renderOffer([tier()]);
    fireEvent.click(screen.getByRole("button", { name: "Jadi anggota — Anggota" }));

    const masuk = await screen.findByTestId("masuk");
    expect(masuk.textContent).toContain("kembali ke /@budi");
    expect(getUserToken()).toBeNull();
    expect(followed.length).toBe(0);
  });
});
