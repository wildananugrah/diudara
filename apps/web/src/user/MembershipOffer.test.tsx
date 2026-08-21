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

function renderOffer(
  tiers: TierView[],
  handle = "budi",
  viewerIsMember = false,
  viewerMembershipEnded = false
) {
  return render(
    <MemoryRouter initialEntries={[`/@${handle}`]}>
      <Routes>
        <Route
          path="/:handleParam"
          element={
            <MembershipOffer
              handle={handle}
              tiers={tiers}
              viewerIsMember={viewerIsMember}
              viewerMembershipEnded={viewerMembershipEnded}
            />
          }
        />
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


/**
 * Task 10 fix round 1, spec §6: "an already-active member sees that they are a
 * member rather than a buy button". `membership.viewerIsMember` is the server's
 * answer, from `IsMemberOf` — the same question Phase 6's paywall asks.
 *
 * §9 is why there is no renew affordance anywhere below: 5a has no renewal
 * pass, and there is no endpoint behind such a button. What this file used to
 * claim — that a lapsed member "simply sees the offer again", and that this was
 * the honest shape — was measured false by the final whole-branch review: the
 * server refuses that purchase permanently, so the offer was a button that
 * could only 409. The lapsed case has its own describe block below.
 */
describe("MembershipOffer — somebody who is already a member", () => {
  it("says they are a member, and offers no way to buy the same thing twice", () => {
    setUserSession("jwt-abc", VIEWER);
    renderOffer([tier()], "budi", true);

    const panel = screen.getByTestId("membership-member");
    expect(panel.textContent).toContain("Anda sudah menjadi anggota");
    expect(screen.queryAllByRole("button", { name: /Jadi anggota/ }).length).toBe(0);
    expect(screen.queryAllByTestId("membership-tier-tier-1").length).toBe(0);
  });

  /**
   * A member of a creator who has since withdrawn every tier. The two halves
   * are independent on the wire (`toMembershipView` takes them separately), and
   * the membership is the true one to show: there is no offer left, but this
   * person still holds one.
   */
  it("still says so when the creator has withdrawn every tier", () => {
    setUserSession("jwt-abc", VIEWER);
    renderOffer([], "budi", true);

    expect(screen.getByTestId("membership-member").textContent).toContain(
      "Anda sudah menjadi anggota"
    );
  });

  /** PRESENCE control: the same profile offers the button to a NON-member. */
  it("shows the buy button, and no membership panel, to somebody who is not a member", () => {
    setUserSession("jwt-abc", VIEWER);
    renderOffer([tier()], "budi", false);

    expect(screen.getByRole("button", { name: "Jadi anggota — Anggota" })).toBeTruthy();
    expect(screen.queryAllByTestId("membership-member").length).toBe(0);
  });

  /**
   * Your own profile still renders NOTHING — the member panel must not become
   * a new way for the own-profile hide to leak. The server answers `false`
   * here anyway (`IsMemberOf` refuses the pair before it queries, and
   * `user_subscription_no_self` makes the row impossible), so this is the
   * belt-and-braces case: even told `true`, the page shows nothing.
   */
  it("renders nothing at all on your own profile, member flag or not", () => {
    setUserSession("jwt-abc", OWNER);
    renderOffer([tier()], "budi", true);

    expect(document.body.textContent).toBe("");
  });

  /**
   * A signed-OUT visitor is never told they are a member. The server answers
   * `false` for an anonymous request by construction (`MembershipView`'s own
   * docstring), and this pins the client half: even handed `true`, a browser
   * with no session gets the route to Masuk, not somebody else's membership.
   */
  it("never claims a membership for a visitor with no session", () => {
    renderOffer([tier()], "budi", true);

    expect(screen.queryAllByTestId("membership-member").length).toBe(0);
    expect(screen.getByRole("link", { name: "Masuk untuk jadi anggota" })).toBeTruthy();
  });
});

/**
 * **THE FINAL WHOLE-BRANCH REVIEW'S C-1.** Phase 5b built renewal — Task 2
 * retires the lapsed row INSIDE the purchase transaction, so pressing "Jadi
 * anggota" once frees `user_subscription_one_active`'s slot and opens a fresh
 * invoice. This screen never learned. It kept rendering 5a's dead end —
 * *"Perpanjangan belum tersedia untuk saat ini"*, with no button — for exactly
 * the window the lazy retirement was built to serve, and for ever if the
 * worker's hourly sweep is not running.
 *
 * So the ended panel stopped being a REFUSAL and became a NOTICE: the member is
 * told their membership ended, and then offered the tiers, because buying again
 * is what renewal is here.
 *
 * `viewerMembershipEnded` is still the server telling this screen which kind of
 * "not a member" it is looking at — it just no longer means "and you cannot
 * buy".
 */
describe("MembershipOffer — somebody whose membership has ENDED", () => {
  it("tells them it ended and OFFERS the tier, with a pressable Jadi anggota", () => {
    setUserSession("jwt-abc", VIEWER);
    renderOffer([tier()], "budi", false, true);

    const panel = screen.getByTestId("membership-ended");
    expect(panel.textContent).toContain("sudah berakhir");
    // The sentence 5b exists to make untrue. It must not survive anywhere on
    // this screen.
    expect(document.body.textContent).not.toContain("Perpanjangan belum tersedia");
    // THE POINT of C-1: there is something to press, it is not disabled, and it
    // is the ordinary buy button — no separate "renew" control, because there is
    // no separate renew endpoint. Buying again IS the renewal.
    const button = screen.getByRole("button", { name: "Jadi anggota — Anggota" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.getByTestId("membership-tier-tier-1").textContent).toContain("Rp 50.000");
  });

  /**
   * The gate checklist's §2 step, at this layer: *"Press Jadi anggota again. It
   * must offer you the tier and let you buy… you should not have to wait for any
   * worker pass."* The request actually leaves, and the browser actually follows
   * the invoice — nothing here waits for the hourly sweep to retire the old row,
   * because `StartUserSubscription` does it inside the purchase transaction.
   */
  it("pressing it starts a real purchase and follows the invoice — no worker pass involved", async () => {
    setUserSession("jwt-abc", VIEWER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(
        {
          invoiceUrl: "https://checkout.xendit.co/web/inv_renew",
          subscriptionId: "sub-2",
          transactionId: "txn-2",
          externalId: "usub_txn-2",
        },
        201
      );
    }) as unknown as typeof fetch;

    renderOffer([tier()], "budi", false, true);
    fireEvent.click(screen.getByRole("button", { name: "Jadi anggota — Anggota" }));

    await waitFor(() => {
      expect(followed.length).toBe(1);
    });
    expect(followed[0]).toBe("https://checkout.xendit.co/web/inv_renew");
    expect(calls[0]!.url).toBe("/users/budi/subscribe");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ tierId: "tier-1" });
  });

  /**
   * The distinction that must not collapse in the OTHER direction. A viewer with
   * no history gets the offer with no notice standing over it — being told a
   * membership of theirs ended when they never held one is a false claim about
   * the caller, the same class of defect `viewerIsMember` guards.
   */
  it("a NON-member with the same viewerIsMember: false gets the button and NO ended notice", () => {
    setUserSession("jwt-abc", VIEWER);
    renderOffer([tier()], "budi", false, false);

    expect(screen.getByRole("button", { name: "Jadi anggota — Anggota" })).toBeTruthy();
    expect(screen.queryAllByTestId("membership-ended").length).toBe(0);
  });

  /**
   * **THE REFUSAL THAT MUST STILL FIRE.** A CURRENTLY ACTIVE member is not
   * offered a second purchase: `StartUserSubscription` answers that 409 (its
   * guard is status-only, and `retireExpired`'s `current_period_end <= now`
   * deliberately does not touch a row still inside its period), and an offer the
   * server refuses is the non-terminating loop 5a shipped. C-1 opened the button
   * for the LAPSED member only.
   */
  it("a LIVE member is still offered NO button and no tiers", () => {
    setUserSession("jwt-abc", VIEWER);
    renderOffer([tier()], "budi", true, false);

    expect(screen.getByTestId("membership-member").textContent).toContain(
      "Anda sudah menjadi anggota"
    );
    expect(screen.queryAllByTestId("membership-ended").length).toBe(0);
    expect(screen.queryAllByRole("button").length).toBe(0);
    expect(screen.queryAllByTestId("membership-tier-tier-1").length).toBe(0);
  });

  /**
   * A creator who has since withdrawn every tier still owes this person the
   * news — and here there genuinely IS nothing to press, so the sentence says
   * why. It does not say renewal is unavailable: renewal exists; this creator's
   * offer does not.
   */
  it("says the creator is not selling anything when every tier has been withdrawn", () => {
    setUserSession("jwt-abc", VIEWER);
    renderOffer([], "budi", false, true);

    const panel = screen.getByTestId("membership-ended");
    expect(panel.textContent).toContain("sudah berakhir");
    expect(panel.textContent).toContain("tidak menawarkan paket keanggotaan");
    expect(screen.queryAllByRole("button").length).toBe(0);
  });

  /** Your own profile still renders NOTHING, ended flag or not. */
  it("renders nothing at all on your own profile", () => {
    setUserSession("jwt-abc", OWNER);
    renderOffer([tier()], "budi", false, true);

    expect(document.body.textContent).toBe("");
  });

  /**
   * A signed-OUT visitor is never told a membership of theirs ended — the
   * server answers `false` by construction, and this pins the client half the
   * same way the member panel's is pinned.
   */
  it("a signed-out browser handed `true` still gets the Masuk link, not the ended notice", () => {
    localStorage.clear();
    renderOffer([tier()], "budi", false, true);

    expect(screen.getByRole("link", { name: "Masuk untuk jadi anggota" })).toBeTruthy();
    expect(screen.queryAllByTestId("membership-ended").length).toBe(0);
  });
});
