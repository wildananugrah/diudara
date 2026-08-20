import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { setUserSession } from "./apiClient";
import MembershipSettings from "./MembershipSettings";

const USER = { handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

/**
 * The three states of `app_user.xendit_account_id`, as the wire reports them,
 * plus the fourth axis `GET /users/me/payout` adds: whether this box has a
 * payment provider at all. Written as literals rather than built from the
 * component's own constants — a test that asserts the constant it checks
 * cannot redden when the constant changes.
 */
const NOT_CONNECTED = { connected: false, provisioning: false, available: true };
const PROVISIONING = { connected: false, provisioning: true, available: true };
const CONNECTED = { connected: true, provisioning: false, available: true };
const NO_PROVIDER = { connected: false, provisioning: false, available: false };

const TIER = {
  id: "tier-1",
  ownerId: "user-1",
  name: "Anggota",
  priceAmount: 50000,
  billingCycle: "monthly",
  isActive: true,
  createdAt: "2026-08-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function methodOf(init: RequestInit | undefined): string {
  return init?.method ?? "GET";
}

/** Installs a `fetch` mock and returns the list it records every call into. */
function mockApi(handler: (url: string, init: RequestInit | undefined) => Response): Call[] {
  const calls: Call[] = [];
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return calls;
}

/**
 * The ordinary server: `GET /users/me/payout` answers `payout`, `GET
 * /users/me/tiers` answers `tiers`, and anything else is a test bug rather
 * than a silent 200.
 */
function serverWith(payout: unknown, tiers: unknown[] = []): Call[] {
  return mockApi((url, init) => {
    if (url === "/users/me/payout" && methodOf(init) === "GET") return jsonResponse(payout);
    if (url === "/users/me/tiers" && methodOf(init) === "GET") return jsonResponse(tiers);
    return jsonResponse({ error: `unexpected ${methodOf(init)} ${url}` }, 500);
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
  setUserSession("jwt-abc", USER);
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("MembershipSettings — the payout account has THREE states, not two", () => {
  it("offers the connect button when no payout account exists at all", async () => {
    serverWith(NOT_CONNECTED);

    render(<MembershipSettings />);

    await screen.findByText("Anda belum menghubungkan akun pembayaran.");
    expect(screen.getAllByRole("button", { name: "Hubungkan akun pembayaran" }).length).toBe(1);
  });

  /**
   * THE STATE THE SENTINEL CREATES. `xendit_account_id` holding
   * `"provisioning:in-progress"` is truthy, and every reader on the server
   * refuses it as NOT connected. A creator waiting on Xendit's KYC must see
   * that they are waiting — not "connected", and not the blank "you have not
   * started" screen that would send them round the connect loop again.
   */
  it("says the account is being VERIFIED while the provisioning claim is held", async () => {
    serverWith(PROVISIONING);

    render(<MembershipSettings />);
    const waiting = await screen.findByText(/Akun pembayaran Anda sedang diverifikasi/);

    // The wait has a cause outside this project's control (Xendit's KYC), so
    // the sentence has to set an expectation rather than just say "tunggu".
    expect(waiting.textContent).toContain("beberapa hari kerja");
  });

  it("renders provisioning as neither connected nor not-yet-started, and offers no button to press", async () => {
    serverWith(PROVISIONING);

    render(<MembershipSettings />);
    await screen.findByText(/Akun pembayaran Anda sedang diverifikasi/);

    expect(screen.queryAllByText("Anda belum menghubungkan akun pembayaran.").length).toBe(0);
    expect(screen.queryAllByText(/sudah terhubung/).length).toBe(0);
    // Pressing connect again cannot help — the claim is already held.
    expect(screen.queryAllByRole("button", { name: "Hubungkan akun pembayaran" }).length).toBe(0);
  });

  it("reports a connected account as ready to receive money", async () => {
    serverWith(CONNECTED);

    render(<MembershipSettings />);

    await screen.findByText(/Akun pembayaran Anda sudah terhubung/);
    expect(screen.queryAllByRole("button", { name: "Hubungkan akun pembayaran" }).length).toBe(0);
  });

  it("says payments are not configured on this server rather than offering a button that cannot work", async () => {
    serverWith(NO_PROVIDER);

    render(<MembershipSettings />);

    await screen.findByText(/Pembayaran belum tersedia di server ini/);
    expect(screen.queryAllByRole("button", { name: "Hubungkan akun pembayaran" }).length).toBe(0);
    expect(screen.queryAllByText("Anda belum menghubungkan akun pembayaran.").length).toBe(0);
  });
});

describe("MembershipSettings — connecting", () => {
  it("POSTs to /users/me/payout and shows the status that call resolved to", async () => {
    const calls = mockApi((url, init) => {
      if (url === "/users/me/payout" && methodOf(init) === "POST") return jsonResponse(CONNECTED);
      if (url === "/users/me/payout") return jsonResponse(NOT_CONNECTED);
      if (url === "/users/me/tiers") return jsonResponse([]);
      return jsonResponse({ error: "unexpected" }, 500);
    });

    render(<MembershipSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Hubungkan akun pembayaran" }));

    await screen.findByText(/Akun pembayaran Anda sudah terhubung/);
    const post = calls.filter((c) => c.url === "/users/me/payout" && methodOf(c.init) === "POST");
    expect(post.length).toBe(1);
    expect(new Headers(post[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
  });

  /**
   * A connect that LOSES the claim — another device got there first — answers
   * `provisioning`, having called nobody. The screen must show waiting, not
   * success.
   */
  it("shows waiting when the connect call comes back mid-provisioning", async () => {
    mockApi((url, init) => {
      if (url === "/users/me/payout" && methodOf(init) === "POST") return jsonResponse(PROVISIONING);
      if (url === "/users/me/payout") return jsonResponse(NOT_CONNECTED);
      return jsonResponse({ error: "unexpected" }, 500);
    });

    render(<MembershipSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Hubungkan akun pembayaran" }));

    await screen.findByText(/Akun pembayaran Anda sedang diverifikasi/);
    expect(screen.queryAllByText(/sudah terhubung/).length).toBe(0);
  });
});

describe("MembershipSettings — the tier editor is gated on a CONNECTED account", () => {
  it("refuses to open the editor, in Bahasa, when no payout account exists", async () => {
    serverWith(NOT_CONNECTED);

    render(<MembershipSettings />);
    const reason = await screen.findByTestId("tier-editor-unavailable");

    expect(reason.textContent).toContain("Hubungkan akun pembayaran Anda terlebih dahulu");
    expect(reason.textContent).toContain("belum punya tempat tujuan");
    expect(screen.queryAllByRole("button", { name: "Terbitkan tingkatan" }).length).toBe(0);
    expect(screen.queryAllByLabelText("Nama tingkatan").length).toBe(0);
  });

  /**
   * THE DISTINCTION THIS WHOLE GATE EXISTS FOR. A truthy `xendit_account_id`
   * holding the sentinel is NOT a payout account: `ManageUserTiers.create`
   * refuses it with a 409, so an editor that opened here would collect a name
   * and a price and then fail. The explanation must say *waiting*, not
   * *connect* — the person has already connected.
   */
  it("keeps the editor shut while the account is mid-provisioning, and says WHY it is waiting", async () => {
    serverWith(PROVISIONING);

    render(<MembershipSettings />);
    const reason = await screen.findByTestId("tier-editor-unavailable");

    expect(reason.textContent).toContain("menunggu verifikasi");
    expect(reason.textContent).toContain("belum punya tempat tujuan");
    expect(reason.textContent).not.toContain("Hubungkan akun pembayaran Anda terlebih dahulu");
    expect(screen.queryAllByRole("button", { name: "Terbitkan tingkatan" }).length).toBe(0);
  });

  it("opens the editor once the account is genuinely connected", async () => {
    serverWith(CONNECTED);

    render(<MembershipSettings />);

    await screen.findByLabelText("Nama tingkatan");
    expect(screen.getAllByRole("button", { name: "Terbitkan tingkatan" }).length).toBe(1);
    expect(screen.queryAllByTestId("tier-editor-unavailable").length).toBe(0);
  });
});

describe("MembershipSettings — creating and withdrawing a tier", () => {
  it("creates a tier and lists it in the offer, priced the way a person reads rupiah", async () => {
    const created = { ...TIER, id: "tier-new", name: "Anggota", priceAmount: 50000 };
    const calls = mockApi((url, init) => {
      if (url === "/users/me/payout") return jsonResponse(CONNECTED);
      if (url === "/users/me/tiers" && methodOf(init) === "POST") return jsonResponse(created, 201);
      if (url === "/users/me/tiers") return jsonResponse([]);
      return jsonResponse({ error: "unexpected" }, 500);
    });

    render(<MembershipSettings />);
    fireEvent.change(await screen.findByLabelText("Nama tingkatan"), {
      target: { value: "Anggota" },
    });
    fireEvent.change(screen.getByLabelText("Harga per bulan (Rp)"), { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("button", { name: "Terbitkan tingkatan" }));

    const offer = await screen.findByTestId("tier-offer");
    await waitFor(() => expect(within(offer).queryAllByText("Anggota").length).toBe(1));
    expect(within(offer).queryAllByText(/Rp 50\.000/).length).toBe(1);

    const post = calls.filter((c) => c.url === "/users/me/tiers" && methodOf(c.init) === "POST");
    expect(post.length).toBe(1);
    expect(JSON.parse(post[0]!.init!.body as string)).toEqual({
      name: "Anggota",
      priceAmount: 50000,
    });
  });

  it("empties the form after a successful create, so a second tap cannot republish the same tier", async () => {
    mockApi((url, init) => {
      if (url === "/users/me/payout") return jsonResponse(CONNECTED);
      if (url === "/users/me/tiers" && methodOf(init) === "POST") return jsonResponse(TIER, 201);
      if (url === "/users/me/tiers") return jsonResponse([]);
      return jsonResponse({ error: "unexpected" }, 500);
    });

    render(<MembershipSettings />);
    fireEvent.change(await screen.findByLabelText("Nama tingkatan"), {
      target: { value: "Anggota" },
    });
    fireEvent.change(screen.getByLabelText("Harga per bulan (Rp)"), { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("button", { name: "Terbitkan tingkatan" }));

    await screen.findByText("Tingkatan diterbitkan.");
    expect((screen.getByLabelText("Nama tingkatan") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Harga per bulan (Rp)") as HTMLInputElement).value).toBe("");
  });

  it("refuses a price of zero without sending anything, naming the rule in Bahasa", async () => {
    const calls = serverWith(CONNECTED);

    render(<MembershipSettings />);
    fireEvent.change(await screen.findByLabelText("Nama tingkatan"), {
      target: { value: "Anggota" },
    });
    fireEvent.change(screen.getByLabelText("Harga per bulan (Rp)"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Terbitkan tingkatan" }));

    await screen.findByText("Harga tingkatan harus lebih dari nol.");
    expect(calls.filter((c) => methodOf(c.init) === "POST").length).toBe(0);
  });

  it("refuses an empty name without sending anything", async () => {
    const calls = serverWith(CONNECTED);

    render(<MembershipSettings />);
    fireEvent.change(await screen.findByLabelText("Harga per bulan (Rp)"), {
      target: { value: "50000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Terbitkan tingkatan" }));

    await screen.findByText("Nama tingkatan tidak boleh kosong.");
    expect(calls.filter((c) => methodOf(c.init) === "POST").length).toBe(0);
  });

  it("deactivating a tier takes it out of the offer and files it under the withdrawn ones", async () => {
    const calls = mockApi((url, init) => {
      if (url === "/users/me/payout") return jsonResponse(CONNECTED);
      if (url === "/users/me/tiers/tier-1" && methodOf(init) === "PATCH") {
        return jsonResponse({ ...TIER, isActive: false });
      }
      if (url === "/users/me/tiers") return jsonResponse([TIER]);
      return jsonResponse({ error: "unexpected" }, 500);
    });

    render(<MembershipSettings />);
    const offer = await screen.findByTestId("tier-offer");
    await waitFor(() => expect(within(offer).queryAllByText("Anggota").length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Nonaktifkan" }));

    await waitFor(() => expect(within(offer).queryAllByText("Anggota").length).toBe(0));
    const withdrawn = screen.getByTestId("tier-withdrawn");
    expect(within(withdrawn).queryAllByText("Anggota").length).toBe(1);

    const patch = calls.filter((c) => methodOf(c.init) === "PATCH");
    expect(patch.length).toBe(1);
    expect(patch[0]!.url).toBe("/users/me/tiers/tier-1");
    expect(JSON.parse(patch[0]!.init!.body as string)).toEqual({ isActive: false });
  });

  it("offers no Nonaktifkan on a tier that is already withdrawn", async () => {
    serverWith(CONNECTED, [{ ...TIER, isActive: false }]);

    render(<MembershipSettings />);
    await screen.findByTestId("tier-withdrawn");

    expect(screen.queryAllByRole("button", { name: "Nonaktifkan" }).length).toBe(0);
  });
});

describe("MembershipSettings — a failure is a Bahasa sentence, never the server's own string", () => {
  it("shows Bahasa when the payout status cannot be loaded", async () => {
    mockApi(() => jsonResponse({ error: "internal server error" }, 500));

    render(<MembershipSettings />);

    // The whole alert's text, not a text MATCH: an exact-string matcher cannot
    // see the server's sentence when a screen appends it to its own, which is
    // the exact shape this rule keeps being broken in.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Server sedang bermasalah");
    expect(alert.textContent).not.toContain("internal server error");
  });

  /**
   * A payout status that could not be READ is still a reason the editor is
   * shut, and leaving the "Tingkatan keanggotaan" heading standing over an
   * empty space says nothing at all. It is also the one gate reason a person
   * can act on themselves.
   */
  it("explains that the editor is shut because the payout status could not be read", async () => {
    mockApi(() => jsonResponse({ error: "internal server error" }, 500));

    render(<MembershipSettings />);
    const reason = await screen.findByTestId("tier-editor-unavailable");

    expect(reason.textContent).toContain("Muat ulang halaman ini");
    expect(reason.textContent).not.toContain("internal server error");
    expect(screen.queryAllByRole("button", { name: "Terbitkan tingkatan" }).length).toBe(0);
  });

  it("shows Bahasa when connecting fails", async () => {
    mockApi((url, init) => {
      if (url === "/users/me/payout" && methodOf(init) === "POST") {
        return jsonResponse({ error: "internal server error" }, 500);
      }
      if (url === "/users/me/payout") return jsonResponse(NOT_CONNECTED);
      return jsonResponse({ error: "unexpected" }, 500);
    });

    render(<MembershipSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Hubungkan akun pembayaran" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Server sedang bermasalah");
    expect(alert.textContent).not.toContain("internal server error");
  });

  /**
   * The 409 `ManageUserTiers.create` answers when the payout account is not
   * connected carries a BAHASA message on the wire — which makes this the
   * easiest place in the app to justify printing what the server sent. The
   * rule is not "English is banned", it is that a screen never prints the
   * wire's text, so this asserts the server's own sentence does NOT appear.
   */
  it("shows Bahasa of its OWN when creating a tier is refused, not the server's sentence", async () => {
    const serverSentence =
      "Hubungkan akun pembayaran Anda terlebih dahulu sebelum menerbitkan tingkatan " +
      "keanggotaan — uang dari tingkatan ini belum punya tempat tujuan.";
    mockApi((url, init) => {
      if (url === "/users/me/payout") return jsonResponse(CONNECTED);
      if (url === "/users/me/tiers" && methodOf(init) === "POST") {
        return jsonResponse({ error: serverSentence }, 409);
      }
      if (url === "/users/me/tiers") return jsonResponse([]);
      return jsonResponse({ error: "unexpected" }, 500);
    });

    render(<MembershipSettings />);
    fireEvent.change(await screen.findByLabelText("Nama tingkatan"), {
      target: { value: "Anggota" },
    });
    fireEvent.change(screen.getByLabelText("Harga per bulan (Rp)"), { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("button", { name: "Terbitkan tingkatan" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Gagal menerbitkan tingkatan");
    expect(alert.textContent).not.toContain(serverSentence);
  });

  it("shows Bahasa when deactivating fails", async () => {
    mockApi((url, init) => {
      if (url === "/users/me/payout") return jsonResponse(CONNECTED);
      if (methodOf(init) === "PATCH") return jsonResponse({ error: "tier not found" }, 404);
      if (url === "/users/me/tiers") return jsonResponse([TIER]);
      return jsonResponse({ error: "unexpected" }, 500);
    });

    render(<MembershipSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Nonaktifkan" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Data yang Anda cari tidak ditemukan");
    expect(alert.textContent).not.toContain("tier not found");
  });
});
