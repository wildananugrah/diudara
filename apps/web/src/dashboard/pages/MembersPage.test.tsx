import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import MembersPage from "./MembersPage";
import { renderPage, stubFetch, TEST_COMMUNITY, type FetchStub, type StubRoute } from "../testing";

const ROSTER = `/communities/${TEST_COMMUNITY.id}/members`;
const CSV = `/communities/${TEST_COMMUNITY.id}/members.csv`;
const COMMUNITY_PATH = `/communities/${TEST_COMMUNITY.id}`;
const JOIN_REQUESTS = `/communities/${TEST_COMMUNITY.id}/join-requests`;

/** Same community, but accepting free join requests instead of payments. */
const REQUEST_COMMUNITY = { ...TEST_COMMUNITY, accessMode: "request" };

const RINA = {
  id: "88888888-8888-4888-8888-888888888888",
  memberId: "99999999-9999-4999-8999-999999999999",
  memberName: "Rina Wulandari",
  memberWhatsappNumber: "+6281299999999",
  tierId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tierName: "Free",
  createdAt: "2026-08-10T02:00:00.000Z",
};

/** A WhatsApp-only signup — `member.name` is null, not `''`. */
const NAMELESS = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  memberId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  memberName: null,
  memberWhatsappNumber: "+6281200000099",
  tierId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tierName: "Free",
  createdAt: "2026-08-11T02:00:00.000Z",
};

const SITI = {
  memberId: "22222222-2222-4222-8222-222222222222",
  subscriptionId: "33333333-3333-4333-8333-333333333333",
  name: "Siti Rahayu",
  whatsappNumber: "+6281234567890",
  tierName: "Paket Bulanan",
  status: "active",
  joinedAt: "2026-07-01T02:00:00.000Z",
  nextBillingDate: "2026-09-01",
};

const AGUS = {
  memberId: "44444444-4444-4444-8444-444444444444",
  subscriptionId: "55555555-5555-4555-8555-555555555555",
  name: "Agus Pratama",
  whatsappNumber: "+6281200000001",
  tierName: "Paket Tahunan",
  status: "past_due",
  joinedAt: "2026-06-01T02:00:00.000Z",
  nextBillingDate: "2026-08-01",
};

const DEWI = {
  memberId: "66666666-6666-4666-8666-666666666666",
  subscriptionId: "77777777-7777-4777-8777-777777777777",
  name: "Dewi Lestari",
  whatsappNumber: "+6281200000002",
  tierName: "Paket Bulanan",
  status: "churned",
  joinedAt: "2026-03-01T02:00:00.000Z",
  nextBillingDate: null,
};

function render() {
  return renderPage(<MembersPage />, {
    path: "/dashboard/c/:communityId/members",
    at: `/dashboard/c/${TEST_COMMUNITY.id}/members`,
  });
}

/**
 * The `<tr>` a member's name sits in — the row a creator actually reads a member's
 * fate from, as opposed to the panel that only describes the last action taken.
 */
function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (row === null) throw new Error(`no roster row for ${name}`);
  return row;
}

/** Presses that member's OWN revoke button and confirms it. */
function revokeFromRow(name: string): void {
  fireEvent.click(within(rowFor(name)).getByRole("button", { name: "Cabut akses" }));
  fireEvent.click(screen.getByRole("button", { name: "Ya, cabut akses" }));
}

/** The community lookup every community screen makes, plus whatever the test needs. */
/**
 * The caller's routes come FIRST and the defaults last, because `stubFetch`
 * sorts by path length and JavaScript's sort is stable — so for two entries with
 * the SAME path (a test overriding `JOIN_REQUESTS` below) the caller's wins.
 *
 * `JOIN_REQUESTS` is defaulted to `[]` for the same reason `CommunitiesPage`'s
 * tests default `/payment-account`: `MembersPage` now loads it for EVERY
 * community, not just request-mode ones (see `JoinRequests`' docstring), so a
 * test that does not care about the queue should not have to think about it.
 * Note that it cannot simply go unstubbed — `COMMUNITY_PATH` is a prefix of it,
 * so an unstubbed call would be answered with the community object rather than
 * failing loudly.
 */
function stub(routes: StubRoute[]) {
  return stubFetch([
    ...routes,
    { path: COMMUNITY_PATH, body: TEST_COMMUNITY },
    { path: JOIN_REQUESTS, body: [] },
  ]);
}

/** Same as `stub`, but the community accepts free join requests. */
function stubRequestMode(routes: StubRoute[]) {
  return stubFetch([
    ...routes,
    { path: COMMUNITY_PATH, body: REQUEST_COMMUNITY },
    { path: JOIN_REQUESTS, body: [] },
  ]);
}

/** How many times the roster itself (not the community lookup) has been fetched so far. */
function countRosterGets(stubbed: FetchStub): number {
  return stubbed.calls.filter((c) => c.method === "GET" && c.url.startsWith(ROSTER)).length;
}

let originalFetch: typeof fetch;
let originalCreateObjectURL: unknown;

beforeEach(() => {
  originalFetch = global.fetch;
  originalCreateObjectURL = (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  (URL as unknown as { createObjectURL?: unknown }).createObjectURL = originalCreateObjectURL;
  cleanup();
});

describe("MembersPage", () => {
  it("lists the roster with the member's tier, status and billing date", async () => {
    stub([{ path: ROSTER, body: { members: [SITI, AGUS], nextCursor: null } }]);

    render();

    expect(await screen.findByText("Siti Rahayu")).toBeTruthy();
    expect(screen.getByText("+6281234567890")).toBeTruthy();
    expect(screen.getByText("Paket Bulanan")).toBeTruthy();
    expect(screen.getByText("Agus Pratama")).toBeTruthy();
  });

  it("EXPLAINS THE THREE STATUSES, and says past-due members STILL have group access", async () => {
    stub([{ path: ROSTER, body: { members: [SITI, AGUS, DEWI], nextCursor: null } }]);

    render();
    await screen.findByText("Siti Rahayu");

    const legend = screen.getByTestId("status-legend").textContent ?? "";
    // The non-obvious one: a creator who reads "lewat jatuh tempo" as "locked out"
    // removes them by hand, which is the exact mistake the grace period prevents.
    expect(legend).toMatch(/MASIH punya akses|masih punya akses/);
    expect(legend).toMatch(/Lewat jatuh tempo/);
    expect(legend).toMatch(/Aktif/);
    expect(legend).toMatch(/Berhenti/);
    expect(legend).toMatch(/sudah dicabut|akses grup sudah dicabut/i);
  });

  it("shows an empty state that says what to do next when there are no members", async () => {
    stub([{ path: ROSTER, body: { members: [], nextCursor: null } }]);

    render();

    expect(await screen.findByText(/Belum ada anggota/)).toBeTruthy();
    // "what to do next", not just "nothing here".
    expect(screen.getByText(/tautan checkout|sebarkan/i)).toBeTruthy();
  });

  it("loads the next page with the keyset cursor and APPENDS, keeping page one", async () => {
    const stubbed = stub([
      { path: ROSTER, body: { members: [SITI], nextCursor: "Y3Vyc29yLTI" } },
      {
        path: `${ROSTER}?limit=25&before=Y3Vyc29yLTI`,
        body: { members: [AGUS], nextCursor: null },
      },
    ]);

    render();
    await screen.findByText("Siti Rahayu");

    fireEvent.click(screen.getByRole("button", { name: /Muat lebih banyak/ }));

    expect(await screen.findByText("Agus Pratama")).toBeTruthy();
    expect(screen.getByText("Siti Rahayu")).toBeTruthy();
    expect(
      stubbed.calls.some((c) => c.url.includes("before=Y3Vyc29yLTI"))
    ).toBe(true);
    // The last page has no cursor, so there is nothing left to load.
    await waitFor(() =>
      expect(screen.queryAllByRole("button", { name: /Muat lebih banyak/ }).length).toBe(0)
    );
  });

  it("does not offer 'load more' when the first page is the last one", async () => {
    stub([{ path: ROSTER, body: { members: [SITI], nextCursor: null } }]);

    render();
    await screen.findByText("Siti Rahayu");

    expect(screen.queryAllByRole("button", { name: /Muat lebih banyak/ }).length).toBe(0);
  });

  it("ASKS FOR CONFIRMATION before revoking, and sends nothing until it is given", async () => {
    const stubbed = stub([{ path: ROSTER, body: { members: [SITI], nextCursor: null } }]);

    render();
    await screen.findByText("Siti Rahayu");

    fireEvent.click(screen.getByRole("button", { name: "Cabut akses" }));

    expect(screen.getByTestId("revoke-confirm").textContent).toMatch(/Siti Rahayu/);
    expect(stubbed.calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Batal" }));
    expect(screen.queryAllByTestId("revoke-confirm").length).toBe(0);
    expect(stubbed.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("revokes on confirmation and reports the automated removal", async () => {
    const stubbed = stub([
      { path: ROSTER, body: { members: [SITI], nextCursor: null } },
      {
        method: "POST",
        path: `${ROSTER}/${SITI.memberId}/revoke`,
        body: {
          revoked: 1,
          automated: true,
          channels: [{ channelId: "c1", platform: "telegram", automated: true }],
        },
      },
    ]);

    render();
    await screen.findByText("Siti Rahayu");

    fireEvent.click(screen.getByRole("button", { name: "Cabut akses" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, cabut akses" }));

    const result = await screen.findByTestId("revoke-result");
    expect(result.textContent).toMatch(/dikeluarkan dari grup/);
    await waitFor(() =>
      expect(stubbed.calls.some((c) => c.method === "POST")).toBe(true)
    );
    const post = stubbed.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`${ROSTER}/${SITI.memberId}/revoke`);
  });

  it("DOES NOT CLAIM SUCCESS when the provider could not remove the member", async () => {
    stub([
      { path: ROSTER, body: { members: [SITI], nextCursor: null } },
      {
        method: "POST",
        path: `${ROSTER}/${SITI.memberId}/revoke`,
        body: {
          revoked: 1,
          automated: false,
          channels: [
            {
              channelId: "c1",
              platform: "telegram",
              automated: false,
              reason: "no_provider_member_id_recorded",
            },
          ],
        },
      },
    ]);

    render();
    await screen.findByText("Siti Rahayu");

    fireEvent.click(screen.getByRole("button", { name: "Cabut akses" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, cabut akses" }));

    const result = await screen.findByTestId("revoke-result");
    const text = result.textContent ?? "";
    // The member is still inside the paid group. Say so, and say who has to act.
    expect(text).toMatch(/BELUM dikeluarkan|belum dikeluarkan/);
    expect(text).toMatch(/manual|sendiri/i);
    // And never the sentence the automated branch prints.
    expect(text).not.toMatch(/sudah dikeluarkan dari grup/);
    expect(result.className).toMatch(/warning/);
    expect(result.getAttribute("role")).toBe("alert");
  });

  it("names the reason the removal could not be automated", async () => {
    stub([
      { path: ROSTER, body: { members: [SITI], nextCursor: null } },
      {
        method: "POST",
        path: `${ROSTER}/${SITI.memberId}/revoke`,
        body: {
          revoked: 1,
          automated: false,
          channels: [
            {
              channelId: "c1",
              platform: "whatsapp",
              automated: false,
              reason: "provider_cannot_gate_access",
            },
          ],
        },
      },
    ]);

    render();
    await screen.findByText("Siti Rahayu");

    fireEvent.click(screen.getByRole("button", { name: "Cabut akses" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, cabut akses" }));

    const result = await screen.findByTestId("revoke-result");
    expect(result.textContent).toMatch(/WhatsApp/);
  });

  it("KEEPS AN UNRESOLVED MANUAL REVOCATION VISIBLE when a second member is revoked", async () => {
    stub([
      { path: ROSTER, body: { members: [SITI, AGUS], nextCursor: null } },
      {
        method: "POST",
        path: `${ROSTER}/${SITI.memberId}/revoke`,
        body: {
          revoked: 1,
          automated: false,
          channels: [
            {
              channelId: "c1",
              platform: "whatsapp",
              automated: false,
              reason: "provider_cannot_gate_access",
            },
          ],
        },
      },
      {
        method: "POST",
        path: `${ROSTER}/${AGUS.memberId}/revoke`,
        body: {
          revoked: 1,
          automated: true,
          channels: [{ channelId: "c2", platform: "telegram", automated: true }],
        },
      },
    ]);

    render();
    await screen.findByText("Siti Rahayu");

    revokeFromRow("Siti Rahayu");
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("revoke-result")
          .some((panel) => (panel.textContent ?? "").includes("Siti Rahayu"))
      ).toBe(true)
    );

    revokeFromRow("Agus Pratama");
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("revoke-result")
          .some((panel) => (panel.textContent ?? "").includes("Agus Pratama"))
      ).toBe(true)
    );

    // SITI IS STILL INSIDE THE PAID GROUP. Dropping her warning to make room for
    // Agus's success panel is the exact dishonesty this screen exists to prevent:
    // the creator's only record that they still have to remove her by hand.
    const panels = screen.getAllByTestId("revoke-result").map((p) => p.textContent ?? "");
    expect(panels.some((t) => t.includes("Siti Rahayu") && /BELUM dikeluarkan/.test(t))).toBe(true);

    // And her ROW must not read like the member who really was removed.
    const sitiRow = rowFor("Siti Rahayu").textContent ?? "";
    const agusRow = rowFor("Agus Pratama").textContent ?? "";
    expect(sitiRow).toMatch(/BELUM keluar dari grup/);
    expect(agusRow).toMatch(/Akses grup dicabut/);
    expect(sitiRow.includes("Akses grup dicabut")).toBe(false);
  });

  it("says the subscription itself is unchanged, because the API does not change it", async () => {
    stub([
      { path: ROSTER, body: { members: [SITI], nextCursor: null } },
      {
        method: "POST",
        path: `${ROSTER}/${SITI.memberId}/revoke`,
        body: {
          revoked: 1,
          automated: true,
          channels: [{ channelId: "c1", platform: "telegram", automated: true }],
        },
      },
    ]);

    render();
    await screen.findByText("Siti Rahayu");

    fireEvent.click(screen.getByRole("button", { name: "Cabut akses" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, cabut akses" }));

    expect((await screen.findByTestId("revoke-result")).textContent).toMatch(
      /status langganan/i
    );
  });

  it("reports a 404 revoke as 'no active access', not as a failure of the screen", async () => {
    stub([
      { path: ROSTER, body: { members: [SITI], nextCursor: null } },
      {
        method: "POST",
        path: `${ROSTER}/${SITI.memberId}/revoke`,
        status: 404,
        body: { error: "member has no active access to this community" },
      },
    ]);

    render();
    await screen.findByText("Siti Rahayu");

    fireEvent.click(screen.getByRole("button", { name: "Cabut akses" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, cabut akses" }));

    expect((await screen.findByTestId("revoke-result")).textContent).toMatch(
      /tidak punya akses aktif/i
    );
  });

  it("does not offer revoke for a member who has already churned", async () => {
    stub([{ path: ROSTER, body: { members: [DEWI], nextCursor: null } }]);

    render();
    await screen.findByText("Dewi Lestari");

    expect(screen.queryAllByRole("button", { name: "Cabut akses" }).length).toBe(0);
  });

  it("downloads the CSV from the .csv endpoint WITH the auth header, not as a bare link", async () => {
    (URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL = () =>
      "blob:stub";
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};

    const stubbed = stub([
      { path: ROSTER, body: { members: [SITI], nextCursor: null } },
      { path: CSV, body: "nama,whatsapp\r\nSiti,+62812\r\n" },
    ]);

    render();
    await screen.findByText("Siti Rahayu");

    fireEvent.click(screen.getByRole("button", { name: /Unduh CSV/ }));

    await waitFor(() => expect(stubbed.calls.some((c) => c.url === CSV)).toBe(true));
    // A bare <a href> would send no Authorization header and download the API's 401.
    expect(screen.queryAllByRole("link", { name: /Unduh CSV/ }).length).toBe(0);
  });

  it("warns that the CSV contains members' personal data", async () => {
    stub([{ path: ROSTER, body: { members: [SITI], nextCursor: null } }]);

    render();
    await screen.findByText("Siti Rahayu");

    expect(screen.getByTestId("csv-note").textContent).toMatch(/nomor WhatsApp|data pribadi/i);
  });

  it("says the community was not found when the id is not one of the creator's", async () => {
    stubFetch([{ path: COMMUNITY_PATH, status: 404, body: { error: "community not found" } }]);

    render();

    expect(await screen.findByText(/Komunitas tidak ditemukan/)).toBeTruthy();
  });
});

describe("MembersPage — join requests (free communities, Task 7)", () => {
  it("shows no join-request section for a paid community with nothing pending", async () => {
    stub([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [] },
    ]);

    render();
    await screen.findByText(/Belum ada anggota/);

    // An EMPTY paid community shows nothing, so it never implies it has
    // requests waiting. It IS asked for now — see the "switched back to paid"
    // tests below for the orphaned rows that made not asking a bug.
    expect(screen.queryAllByText(/Permintaan bergabung/).length).toBe(0);
  });

  it("shows the pending queue for a request-mode community, with a count in the heading", async () => {
    stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [RINA] },
    ]);

    render();

    expect(await screen.findByText("Permintaan bergabung (1)")).toBeTruthy();
    expect(screen.getByText("Rina Wulandari")).toBeTruthy();
    expect(screen.getByText(RINA.memberWhatsappNumber)).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();
  });

  it("shows a zero count rather than an empty list that could be mistaken for absence", async () => {
    stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [] },
    ]);

    render();

    expect(await screen.findByText("Permintaan bergabung (0)")).toBeTruthy();
  });

  it("RENDERS 'Tanpa nama' DE-EMPHASISED, with the WhatsApp number beside it, for a null member name", async () => {
    stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [NAMELESS] },
    ]);

    render();

    const cell = await screen.findByText(/Tanpa nama/);
    expect(cell.textContent).toContain(NAMELESS.memberWhatsappNumber);
    expect(cell.className).toMatch(/muted/);
  });

  it("APPROVES WITH NO CONFIRMATION, removes the row, and refreshes the roster", async () => {
    const stubbed = stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [RINA] },
      {
        method: "POST",
        path: `${JOIN_REQUESTS}/${RINA.id}/approve`,
        body: { subscriptionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      },
    ]);

    render();
    await screen.findByText("Rina Wulandari");
    // Counted as a BASELINE, not a fixed number: StrictMode (see testing.tsx)
    // double-invokes the mount effect, so the roster is already fetched more
    // than once before any decision happens. What matters here is that a
    // decision causes at least one MORE fetch, not the absolute count.
    const rosterGetsBeforeDecision = countRosterGets(stubbed);

    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));

    // No confirmation dialog ever appears for an approval.
    expect(screen.queryAllByTestId("reject-confirm").length).toBe(0);

    await waitFor(() => expect(screen.queryAllByText("Rina Wulandari").length).toBe(0));
    // The roster is refetched — an approved member must show up without a
    // manual reload.
    await waitFor(() =>
      expect(countRosterGets(stubbed)).toBeGreaterThan(rosterGetsBeforeDecision)
    );
  });

  it("ASKS FOR CONFIRMATION before rejecting, and sends nothing until it is given", async () => {
    const stubbed = stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [RINA] },
    ]);

    render();
    await screen.findByText("Rina Wulandari");

    fireEvent.click(screen.getByRole("button", { name: "Tolak" }));

    expect(screen.getByTestId("reject-confirm").textContent).toMatch(/Rina Wulandari/);
    expect(stubbed.calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Batal" }));
    expect(screen.queryAllByTestId("reject-confirm").length).toBe(0);
    expect(stubbed.calls.some((c) => c.method === "POST")).toBe(false);
    // Cancelling leaves the request exactly where it was.
    expect(screen.getByText("Rina Wulandari")).toBeTruthy();
  });

  it("rejects on confirmation, removes the row, and refreshes the roster", async () => {
    const stubbed = stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [RINA] },
      {
        method: "POST",
        path: `${JOIN_REQUESTS}/${RINA.id}/reject`,
        body: { subscriptionId: null },
      },
    ]);

    render();
    await screen.findByText("Rina Wulandari");
    const rosterGetsBeforeDecision = countRosterGets(stubbed);

    fireEvent.click(screen.getByRole("button", { name: "Tolak" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, tolak permintaan" }));

    await waitFor(() => expect(screen.queryAllByText("Rina Wulandari").length).toBe(0));
    await waitFor(() =>
      expect(countRosterGets(stubbed)).toBeGreaterThan(rosterGetsBeforeDecision)
    );
    const post = stubbed.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`${JOIN_REQUESTS}/${RINA.id}/reject`);
  });

  it("shows a message and refreshes, rather than leaving a stale row, when the request was already decided elsewhere (409)", async () => {
    const stubbed = stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [RINA] },
      {
        method: "POST",
        path: `${JOIN_REQUESTS}/${RINA.id}/approve`,
        status: 409,
        body: { error: "permintaan ini sudah diproses" },
      },
    ]);

    render();
    await screen.findByText("Rina Wulandari");
    const rosterGetsBeforeDecision = countRosterGets(stubbed);

    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));

    expect((await screen.findByTestId("join-request-conflict")).textContent).toMatch(
      /sudah diproses|tab lain|perangkat lain/i
    );
    await waitFor(() => expect(screen.queryAllByText("Rina Wulandari").length).toBe(0));
    await waitFor(() =>
      expect(countRosterGets(stubbed)).toBeGreaterThan(rosterGetsBeforeDecision)
    );
  });

  it("KEEPS THE ROW for a deactivated-tier 409, and shows the API's own actionable message rather than 'decided elsewhere'", async () => {
    // The exact message `DecideJoinRequest` throws at decide-join-request.ts:77 —
    // it ends by telling the owner to reject, which only works if the row
    // is still there afterwards.
    const DEACTIVATED_TIER_MESSAGE =
      "tier ini sudah tidak aktif. Aktifkan kembali tier tersebut atau tolak permintaan ini.";
    const stubbed = stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [RINA] },
      {
        method: "POST",
        path: `${JOIN_REQUESTS}/${RINA.id}/approve`,
        status: 409,
        body: { error: DEACTIVATED_TIER_MESSAGE },
      },
    ]);

    render();
    await screen.findByText("Rina Wulandari");

    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));

    // The row's own error text, not the "decided elsewhere" banner.
    const row = await waitFor(() => rowFor("Rina Wulandari"));
    await waitFor(() => expect(row.textContent).toMatch(/tier ini sudah tidak aktif/));
    expect(screen.queryAllByTestId("join-request-conflict").length).toBe(0);
    // The row is STILL THERE, with its buttons — an owner can still act on
    // the API's own instruction and reject it.
    expect(screen.getByText("Rina Wulandari")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Tolak" })).toBeTruthy();

    // Reaching the reject confirmation from here must still work — this is
    // exactly commit 38de515's guarantee, which a blanket "already decided"
    // removal would silently defeat. (Not carrying it through to an actual
    // POST: no reject route is stubbed in this test, and stubFetch records
    // a call before it throws for an unstubbed one, which would corrupt the
    // very call log this test would otherwise want to inspect.)
    fireEvent.click(within(row).getByRole("button", { name: "Tolak" }));
    expect(screen.getByTestId("reject-confirm").textContent).toMatch(/Rina Wulandari/);
    expect(stubbed.calls.some((c) => c.method === "POST" && c.url.endsWith("/reject"))).toBe(
      false
    );
  });

  it("shows the row's error text for an already-active-member 409 too, and keeps the row", async () => {
    const ALREADY_ACTIVE_MESSAGE = "anggota ini sudah menjadi member aktif di tier tersebut.";
    stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [RINA] },
      {
        method: "POST",
        path: `${JOIN_REQUESTS}/${RINA.id}/approve`,
        status: 409,
        body: { error: ALREADY_ACTIVE_MESSAGE },
      },
    ]);

    render();
    await screen.findByText("Rina Wulandari");

    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));

    const row = await waitFor(() => rowFor("Rina Wulandari"));
    await waitFor(() => expect(row.textContent).toMatch(/sudah menjadi member aktif/));
    expect(screen.queryAllByTestId("join-request-conflict").length).toBe(0);
  });

  it("translates a 404 (the request no longer exists) into Indonesian and removes the row", async () => {
    const stubbed = stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [RINA] },
      {
        method: "POST",
        path: `${JOIN_REQUESTS}/${RINA.id}/approve`,
        status: 404,
        // The API's real, deliberately-English anti-enumeration string —
        // see decide-join-request.ts:62 — which must never reach the owner.
        body: { error: "join request not found" },
      },
    ]);

    render();
    await screen.findByText("Rina Wulandari");
    const rosterGetsBeforeDecision = countRosterGets(stubbed);

    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));

    const notice = await screen.findByTestId("join-request-conflict");
    expect(notice.textContent).not.toMatch(/join request not found/);
    expect(notice.textContent).toMatch(/sudah tidak ada|muat ulang/i);
    await waitFor(() => expect(screen.queryAllByText("Rina Wulandari").length).toBe(0));
    await waitFor(() =>
      expect(countRosterGets(stubbed)).toBeGreaterThan(rosterGetsBeforeDecision)
    );
  });

  it("lets the owner dismiss the notice banner instead of it staying until reload", async () => {
    stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [RINA] },
      {
        method: "POST",
        path: `${JOIN_REQUESTS}/${RINA.id}/approve`,
        status: 409,
        body: { error: "permintaan ini sudah diproses" },
      },
    ]);

    render();
    await screen.findByText("Rina Wulandari");

    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));
    await screen.findByTestId("join-request-conflict");

    fireEvent.click(screen.getByRole("button", { name: "Tutup" }));
    expect(screen.queryAllByTestId("join-request-conflict").length).toBe(0);
  });

  it("shows the approved member ON THE ROSTER ITSELF, above a populated roster — not just a second fetch", async () => {
    let approved = false;
    const approvedRow = {
      memberId: RINA.memberId,
      subscriptionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      name: RINA.memberName,
      whatsappNumber: RINA.memberWhatsappNumber,
      tierName: RINA.tierName,
      status: "active",
      joinedAt: "2026-08-12T02:00:00.000Z",
      nextBillingDate: null,
    };
    stubRequestMode([
      {
        path: ROSTER,
        bodyFn: () => ({
          members: approved ? [SITI, approvedRow] : [SITI],
          nextCursor: null,
        }),
      },
      { path: JOIN_REQUESTS, body: [RINA] },
      {
        method: "POST",
        path: `${JOIN_REQUESTS}/${RINA.id}/approve`,
        body: { subscriptionId: approvedRow.subscriptionId },
      },
    ]);

    render();
    await screen.findByText("Rina Wulandari");
    // The queue sits above a REAL, populated roster, not an empty one.
    expect(screen.getByText("Siti Rahayu")).toBeTruthy();

    approved = true;
    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));

    // The pending row disappears, then the SAME name reappears — this time
    // as a roster row, with a status badge, not the pending queue's row.
    // Checked as ONE snapshot inside a single `waitFor` callback, not a
    // count-check followed by a separate synchronous read: the two-step
    // version raced the roster's own refetch settling in between (the
    // `await waitFor(...)` boundary itself yields to the microtask queue),
    // so the count could pass transiently against the very state the next
    // line no longer saw.
    await waitFor(() => {
      const matches = screen.queryAllByText("Rina Wulandari");
      expect(matches.length).toBe(1);
      const rowText = matches[0]!.closest("tr")?.textContent ?? "";
      expect(rowText).toMatch(/Aktif/);
      expect(rowText.includes(RINA.memberWhatsappNumber)).toBe(true);
    });
  });
});

/**
 * The gate's IMPORTANT 3. `MembersPage` rendered the queue only when
 * `accessMode === "request"`, and `JoinRequests`' own docstring asserted "a paid
 * community has no `join_request` rows at all" — falsified by execution.
 *
 * Switching a community from `request` back to `paid` leaves its PENDING rows
 * exactly where they were. The API still returns them, `DecideJoinRequest` still
 * decides them (it never looks at `accessMode`), and the member's own page still
 * says "menunggu persetujuan" — but the owner's dashboard stopped showing them,
 * so nobody could act. Recoverable only by switching back, which an owner has no
 * way to know.
 */
describe("MembersPage — join requests orphaned by a switch back to paid (gate fix round)", () => {
  it("still shows pending requests on a PAID community, so they can be decided", async () => {
    stub([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [RINA] },
    ]);

    render();

    expect(await screen.findByText("Permintaan bergabung (1)")).toBeTruthy();
    expect(screen.getByText("Rina Wulandari")).toBeTruthy();
    // Both decisions are genuinely available: DecideJoinRequest never checks
    // accessMode, so neither button is a dead end.
    expect(screen.getByRole("button", { name: "Setujui" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tolak" })).toBeTruthy();
  });

  it("explains WHY a paid community has a queue at all, rather than just showing one", async () => {
    stub([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [RINA] },
    ]);

    render();
    await screen.findByText("Permintaan bergabung (1)");

    expect(screen.getByTestId("join-requests-orphaned").textContent).toMatch(/berbayar/i);
  });

  it("does not show that explanation on a request-mode community, where a queue is normal", async () => {
    stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [RINA] },
    ]);

    render();
    await screen.findByText("Permintaan bergabung (1)");

    expect(screen.queryAllByTestId("join-requests-orphaned").length).toBe(0);
  });

  it("keeps the honest zero-count section on a REQUEST community with nothing pending", async () => {
    stubRequestMode([
      { path: ROSTER, body: { members: [], nextCursor: null } },
      { path: JOIN_REQUESTS, body: [] },
    ]);

    render();

    // Unchanged from Task 7: a request-mode community legitimately has an empty
    // queue, and saying "(0)" is honest. Only the PAID+empty case renders nothing.
    expect(await screen.findByText("Permintaan bergabung (0)")).toBeTruthy();
  });
});
