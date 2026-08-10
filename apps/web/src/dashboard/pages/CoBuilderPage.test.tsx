import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import CoBuilderPage from "./CoBuilderPage";
import { resetPaymentAccountCacheForTesting } from "../paymentAccount";
import { renderPage, stubFetch, type StubRoute } from "../testing";

const AI_ENABLED: StubRoute = { path: "/ai/status", body: { enabled: true } };
const AI_DISABLED: StubRoute = { path: "/ai/status", body: { enabled: false } };
/** `PaymentAccountNotice` fetches this on every mount of the enabled chat —
 * default it to "connected" so a test that does not care about the warning
 * does not have to think about it, same convention as CommunitiesPage.test.tsx
 * and TiersPage.test.tsx. */
const PAYMENT_CONNECTED: StubRoute = {
  path: "/payment-account",
  body: { connected: true, provisioning: false },
};

const VALID_DRAFT = {
  name: "Kelas Bisnis Digital",
  niche: "Bisnis online untuk pemula",
  description: "Komunitas untuk pelaku UMKM yang ingin belajar bisnis digital dari nol.",
  welcomeMessage: "Selamat datang di Kelas Bisnis Digital!",
  tiers: [
    { name: "Dasar", priceAmount: 50000, billingCycle: "monthly" },
    { name: "Pro", priceAmount: 150000, billingCycle: "monthly" },
  ],
};

const CREATED_COMMUNITY = {
  id: "22222222-2222-4222-8222-222222222222",
  creatorId: "creator-1",
  name: "Kelas Bisnis Digital",
  slug: "kelas-bisnis-digital",
  niche: "Bisnis online untuk pemula",
  status: "active",
  createdAt: "2026-08-10T02:00:00.000Z",
};

function render() {
  return renderPage(<CoBuilderPage />, { path: "/dashboard/co-builder", at: "/dashboard/co-builder" });
}

async function sendMessage(text: string) {
  fireEvent.change(screen.getByLabelText("Pesan Anda"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Kirim" }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * A hand-rolled `global.fetch` for the tests that need per-call, stateful
 * routing `stubFetch` cannot express (a route that answers differently on its
 * second call) — but, unlike the previous round's version, this one RECORDS
 * every call the way `stubFetch`'s does, so a test can assert an actual
 * request count instead of inferring it from what one render happens to show.
 */
function recordingFetch(
  handler: (url: string, method: string, body: unknown) => Response | Promise<Response>
): { calls: Array<{ url: string; method: string; body: unknown }> } {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    let parsedBody: unknown = null;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ url, method, body: parsedBody });
    return handler(url, method, parsedBody);
  }) as unknown as typeof fetch;
  return { calls };
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

describe("CoBuilderPage", () => {
  it("shows a prompt suggesting what to say when there are no messages yet", async () => {
    stubFetch([AI_ENABLED, PAYMENT_CONNECTED]);
    render();

    expect(await screen.findByText(/Mulai obrolan dengan AI Co-Builder/)).toBeTruthy();
    expect(screen.getByText(/Saya mau bikin komunitas belajar saham/)).toBeTruthy();
  });

  it("says the feature is not active rather than showing a chat that would only error", async () => {
    stubFetch([AI_DISABLED]);
    render();

    expect(await screen.findByText(/Fitur AI Co-Builder belum aktif/)).toBeTruthy();
    // No composer at all — never a screen that can reach a 503 on its own.
    expect(screen.queryAllByLabelText("Pesan Anda").length).toBe(0);
  });

  it("warns that payments are not connected — the same guardrail CommunitiesPage and TiersPage show", async () => {
    stubFetch([AI_ENABLED, { path: "/payment-account", body: { connected: false, provisioning: false } }]);
    render();

    const notice = await screen.findByTestId("payment-account-notice");
    expect(notice.textContent).toMatch(/belum bisa membayar|belum terhubung/);
  });

  it("clears the payment warning once the server reports payments connected", async () => {
    // `getPaymentAccountState()` answers "loading" until the GET resolves, and
    // `PaymentAccountNotice` renders its warning for "loading" too — so a test
    // that only asserts the warning is PRESENT (the one above) would pass
    // just as well with `connected: true` stubbed, never actually reading the
    // body `findByTestId` resolved before. This one waits for the warning to
    // be there FIRST (proving the component mounted and is subscribed), then
    // waits for the GET to actually land and clear it.
    stubFetch([AI_ENABLED, { path: "/payment-account", body: { connected: true, provisioning: false } }]);
    render();

    await screen.findByTestId("payment-account-notice");
    await waitFor(() => expect(screen.queryAllByTestId("payment-account-notice").length).toBe(0));
  });

  it("sends a message and shows the assistant's reply plus the resulting draft", async () => {
    const stub = stubFetch([
      AI_ENABLED,
      PAYMENT_CONNECTED,
      {
        method: "POST",
        path: "/ai/messages",
        body: { conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: VALID_DRAFT },
      },
    ]);
    render();
    await screen.findByText(/Mulai obrolan/);

    await sendMessage("Aku mau bikin komunitas belajar bisnis digital");

    expect(await screen.findByText("Berikut draf komunitasmu.")).toBeTruthy();
    expect(await screen.findByText("Aku mau bikin komunitas belajar bisnis digital")).toBeTruthy();
    const post = stub.calls.find((c) => c.method === "POST" && c.url === "/ai/messages")!;
    expect(post.body).toEqual({
      conversationId: null,
      content: "Aku mau bikin komunitas belajar bisnis digital",
    });

    // The draft arrives pre-filled and editable.
    expect((screen.getByLabelText("Nama komunitas") as HTMLInputElement).value).toBe("Kelas Bisnis Digital");
    expect((screen.getByLabelText("Bidang") as HTMLInputElement).value).toBe("Bisnis online untuk pemula");
    expect((screen.getByLabelText("Nama paket 1") as HTMLInputElement).value).toBe("Dasar");
    expect((screen.getByLabelText("Harga paket 1 (Rupiah)") as HTMLInputElement).value).toBe("50000");
    // Integer Rupiah, formatted the same way TiersPage does.
    expect(screen.getByText(/Rp 50\.000/)).toBeTruthy();
  });

  it("shows the AI-thinking indicator only while a reply is in flight", async () => {
    let resolveReply: (() => void) | null = null;
    const { calls } = recordingFetch((url, method) => {
      if (url === "/ai/status") return jsonResponse({ enabled: true });
      if (url === "/payment-account") return jsonResponse({ connected: true, provisioning: false });
      if (url === "/ai/messages" && method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveReply = () =>
            resolve(jsonResponse({ conversationId: "conv-1", reply: "Balasan selesai.", draft: null }));
        });
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    });

    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("halo");

    expect(await screen.findByTestId("ai-thinking")).toBeTruthy();

    resolveReply!();
    await screen.findByText("Balasan selesai.");
    expect(screen.queryAllByTestId("ai-thinking").length).toBe(0);
    expect(calls.filter((c) => c.method === "POST" && c.url === "/ai/messages").length).toBe(1);
  });

  it("says description and welcomeMessage are not stored, and never sends them", async () => {
    const stub = stubFetch([
      AI_ENABLED,
      PAYMENT_CONNECTED,
      {
        method: "POST",
        path: "/ai/messages",
        body: { conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: VALID_DRAFT },
      },
      { method: "POST", path: "/communities", status: 201, body: CREATED_COMMUNITY },
    ]);
    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("halo");
    await screen.findByText("Berikut draf komunitasmu.");

    expect(screen.getAllByText(/Tidak disimpan ke server/).length).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.url === "/communities")).toBe(true));

    const communityPost = stub.calls.find((c) => c.method === "POST" && c.url === "/communities")!;
    expect(communityPost.body).toEqual({ name: "Kelas Bisnis Digital", niche: "Bisnis online untuk pemula" });
  });

  it("renders model output as literal text — an XSS payload creates no element", async () => {
    stubFetch([
      AI_ENABLED,
      PAYMENT_CONNECTED,
      {
        method: "POST",
        path: "/ai/messages",
        body: {
          conversationId: "conv-1",
          reply: "Coba ini: <img src=x onerror=alert(1)>",
          draft: null,
        },
      },
    ]);
    render();
    await screen.findByText(/Mulai obrolan/);

    await sendMessage("halo");

    expect(await screen.findByText("Coba ini: <img src=x onerror=alert(1)>")).toBeTruthy();
    // A COUNT, never `.toBeNull()` on a DOM element — see
    // src/test/no-hanging-dom-assertions.test.ts for why.
    expect(document.querySelectorAll("img").length).toBe(0);
  });

  it("renders a 429 with its own pinned title naming the reset time, offers no retry, and keeps the typed message", async () => {
    stubFetch([
      AI_ENABLED,
      PAYMENT_CONNECTED,
      {
        method: "POST",
        path: "/ai/messages",
        status: 429,
        body: {
          error: "Batas harian AI co-builder sudah tercapai. Coba lagi setelah 11 Agustus 2026 pukul 07:00 WIB.",
          resetAt: "2026-08-11T00:00:00.000Z",
        },
      },
    ]);
    render();
    await screen.findByText(/Mulai obrolan/);

    await sendMessage("pesan yang ditolak");

    const notice = await screen.findByTestId("send-error");
    // The TITLE itself is pinned — not just "the combined text happens to
    // contain the word somewhere", which the stubbed body would satisfy
    // regardless of what this screen renders.
    expect(notice.querySelector("h3")?.textContent).toBe("Anda sudah mencapai batas harian");
    expect(notice.textContent).toMatch(/WIB/);
    // A generic error banner never renders — the 429 gets its own wording.
    expect(screen.queryAllByText("Gagal mengirim pesan").length).toBe(0);
    // No retry offered — retrying before the cap resets cannot succeed.
    expect(screen.queryAllByRole("button", { name: "Coba lagi" }).length).toBe(0);
    // The creator's own words are not lost.
    expect((screen.getByLabelText("Pesan Anda") as HTMLTextAreaElement).value).toBe("pesan yang ditolak");
  });

  it("keeps the conversation and offers a retry on a provider failure, without losing the typed message", async () => {
    let attempt = 0;
    const { calls } = recordingFetch((url, method) => {
      if (url === "/ai/status") return jsonResponse({ enabled: true });
      if (url === "/payment-account") return jsonResponse({ connected: true, provisioning: false });
      if (url === "/ai/messages" && method === "POST") {
        attempt += 1;
        if (attempt === 1) {
          return jsonResponse(
            { error: "AI co-builder sedang tidak bisa dihubungi. Coba lagi dalam beberapa saat." },
            503
          );
        }
        return jsonResponse({ conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: null });
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    });

    render();
    await screen.findByText(/Mulai obrolan/);

    await sendMessage("pesan pertama");

    const notice = await screen.findByTestId("send-error");
    expect(notice.textContent).toMatch(/tidak bisa dihubungi/);
    expect((screen.getByLabelText("Pesan Anda") as HTMLTextAreaElement).value).toBe("pesan pertama");

    fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));

    expect(await screen.findByText("Berikut draf komunitasmu.")).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST" && c.url === "/ai/messages").length).toBe(2);
  });

  it("treats an unknown/foreign conversation (404) distinctly and starts fresh on retry", async () => {
    let attempt = 0;
    const { calls } = recordingFetch((url, method, body) => {
      if (url === "/ai/status") return jsonResponse({ enabled: true });
      if (url === "/payment-account") return jsonResponse({ connected: true, provisioning: false });
      if (url === "/ai/messages" && method === "POST") {
        attempt += 1;
        if (attempt === 1) {
          return jsonResponse({ conversationId: "conv-1", reply: "Baik, ceritakan lebih lanjut.", draft: null });
        }
        if (attempt === 2) {
          expect((body as { conversationId: string }).conversationId).toBe("conv-1");
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        expect((body as { conversationId: string | null }).conversationId).toBeNull();
        return jsonResponse({ conversationId: "conv-2", reply: "Mulai lagi ya.", draft: null });
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    });

    render();
    await screen.findByText(/Mulai obrolan/);

    await sendMessage("pesan pertama");
    await screen.findByText("Baik, ceritakan lebih lanjut.");

    await sendMessage("pesan kedua");

    const notice = await screen.findByTestId("send-error");
    expect(notice.textContent).toMatch(/tidak ditemukan/i);

    fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));

    expect(await screen.findByText("Mulai lagi ya.")).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST" && c.url === "/ai/messages").length).toBe(3);
  });

  it("refuses a non-integer tier price without asking the API, and puts the error under the PRICE field", async () => {
    const stub = stubFetch([
      AI_ENABLED,
      PAYMENT_CONNECTED,
      {
        method: "POST",
        path: "/ai/messages",
        body: { conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: VALID_DRAFT },
      },
    ]);
    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("halo");
    await screen.findByText("Berikut draf komunitasmu.");

    fireEvent.change(screen.getByLabelText("Harga paket 1 (Rupiah)"), { target: { value: "50000,50" } });
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));

    expect((await screen.findByTestId("error-tier-price-0")).textContent).toMatch(/bilangan bulat/);
    expect(screen.queryAllByTestId("error-tier-name-0").length).toBe(0);
    expect(stub.calls.some((c) => c.method === "POST" && c.url === "/communities")).toBe(false);
  });

  it("refuses a blank tier name without asking the API, and puts the error under the NAME field", async () => {
    stubFetch([
      AI_ENABLED,
      PAYMENT_CONNECTED,
      {
        method: "POST",
        path: "/ai/messages",
        body: { conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: VALID_DRAFT },
      },
    ]);
    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("halo");
    await screen.findByText("Berikut draf komunitasmu.");

    fireEvent.change(screen.getByLabelText("Nama paket 1"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));

    expect((await screen.findByTestId("error-tier-name-0")).textContent).toMatch(/wajib diisi/);
    expect(screen.queryAllByTestId("error-tier-price-0").length).toBe(0);
  });

  it("edits the draft (name, niche, tier name, price, and billing cycle) before saving, and saves the edited values", async () => {
    const stub = stubFetch([
      AI_ENABLED,
      PAYMENT_CONNECTED,
      {
        method: "POST",
        path: "/ai/messages",
        body: { conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: VALID_DRAFT },
      },
      { method: "POST", path: "/communities", status: 201, body: CREATED_COMMUNITY },
      {
        method: "POST",
        path: `/communities/${CREATED_COMMUNITY.id}/tiers`,
        status: 201,
        body: { id: "tier-1", communityId: CREATED_COMMUNITY.id, name: "Dasar Plus", priceAmount: 75000, billingCycle: "yearly", isActive: true },
      },
    ]);
    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("halo");
    await screen.findByText("Berikut draf komunitasmu.");

    fireEvent.change(screen.getByLabelText("Nama komunitas"), { target: { value: "Kelas Edit" } });
    fireEvent.change(screen.getByLabelText("Bidang"), { target: { value: "Edit niche" } });
    fireEvent.change(screen.getByLabelText("Nama paket 1"), { target: { value: "Dasar Plus" } });
    fireEvent.change(screen.getByLabelText("Harga paket 1 (Rupiah)"), { target: { value: "75000" } });
    // A hallucinated cycle is exactly what "look at the price" cannot fix —
    // this must be a real, editable `<select>`, the same one TiersPage has.
    fireEvent.change(screen.getByLabelText("Siklus paket 1"), { target: { value: "yearly" } });

    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));

    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.url === "/communities")).toBe(true));
    const communityPost = stub.calls.find((c) => c.method === "POST" && c.url === "/communities")!;
    expect(communityPost.body).toEqual({ name: "Kelas Edit", niche: "Edit niche" });

    await waitFor(() =>
      expect(stub.calls.some((c) => c.method === "POST" && c.url.includes("/tiers"))).toBe(true)
    );
    const tierPosts = stub.calls.filter((c) => c.method === "POST" && c.url.includes("/tiers"));
    expect(tierPosts[0].body).toEqual({ name: "Dasar Plus", priceAmount: 75000, billingCycle: "yearly" });
  });

  it("on a partial save failure, shows what succeeded and failed, retries only the failed tier, and never re-creates the community", async () => {
    let tierAttempt = 0;
    const { calls } = recordingFetch((url, method, body) => {
      if (url === "/ai/status") return jsonResponse({ enabled: true });
      if (url === "/payment-account") return jsonResponse({ connected: true, provisioning: false });
      if (url === "/ai/messages" && method === "POST") {
        return jsonResponse({ conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: VALID_DRAFT });
      }
      if (url === "/communities" && method === "POST") {
        return jsonResponse(CREATED_COMMUNITY, 201);
      }
      if (url === `/communities/${CREATED_COMMUNITY.id}/tiers` && method === "POST") {
        const tierBody = body as { name: string };
        if (tierBody.name === "Dasar") {
          return jsonResponse({ id: "tier-1", communityId: CREATED_COMMUNITY.id, ...tierBody, isActive: true }, 201);
        }
        tierAttempt += 1;
        if (tierAttempt === 1) {
          return jsonResponse({ error: "priceAmount: too large" }, 400);
        }
        return jsonResponse({ id: "tier-2", communityId: CREATED_COMMUNITY.id, ...tierBody, isActive: true }, 201);
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    });

    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("halo");
    await screen.findByText("Berikut draf komunitasmu.");

    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));

    // The community itself is reported as created, with a way to see it.
    expect(await screen.findByText(/berhasil dibuat/)).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Lihat komunitas" })).toBeTruthy();

    // One tier succeeded, one failed — both visible, not just a blanket error,
    // and the failure is split into the PRICE field specifically.
    expect(await screen.findByText("Sudah ditambahkan.")).toBeTruthy();
    expect(await screen.findByTestId("error-tier-price-1")).toBeTruthy();
    expect(screen.getByTestId("error-tier-price-1").textContent).toContain("too large");

    const retryButton = await screen.findByRole("button", { name: "Coba lagi paket yang gagal" });
    fireEvent.click(retryButton);

    await waitFor(() => expect(tierAttempt).toBe(2));
    expect(screen.queryAllByText(/too large/).length).toBe(0);

    // The ACTUAL request counts, not an inference from how many times a
    // heading renders (that renders once per `saveState` regardless of how
    // many requests produced it, so it cannot catch a duplicate POST).
    expect(calls.filter((c) => c.method === "POST" && c.url === "/communities").length).toBe(1);
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/tiers")).length).toBe(3);
  });

  it("recovers from a 400 on POST /communities: fields stay editable and 'Coba lagi' issues a second request", async () => {
    let communityAttempts = 0;
    const { calls } = recordingFetch((url, method) => {
      if (url === "/ai/status") return jsonResponse({ enabled: true });
      if (url === "/payment-account") return jsonResponse({ connected: true, provisioning: false });
      if (url === "/ai/messages" && method === "POST") {
        return jsonResponse({ conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: VALID_DRAFT });
      }
      if (url === "/communities" && method === "POST") {
        communityAttempts += 1;
        if (communityAttempts === 1) {
          return jsonResponse({ error: "name: String must contain at most 255 character(s)" }, 400);
        }
        return jsonResponse(CREATED_COMMUNITY, 201);
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    });

    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("halo");
    await screen.findByText("Berikut draf komunitasmu.");

    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));

    await screen.findByText(/String must contain at most 255/);

    // NOT BRICKED: the name field is editable again, and a retry control exists.
    expect((screen.getByLabelText("Nama komunitas") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("Bidang") as HTMLInputElement).disabled).toBe(false);
    const retryButton = screen.getByRole("button", { name: "Coba lagi" });

    fireEvent.click(retryButton);

    await screen.findByText(/berhasil dibuat/);
    expect(calls.filter((c) => c.method === "POST" && c.url === "/communities").length).toBe(2);
  });

  it("recovers from a rejected fetch (network blip) on POST /communities: fields stay editable and 'Coba lagi' issues a second request", async () => {
    let communityAttempts = 0;
    const { calls } = recordingFetch((url, method) => {
      if (url === "/ai/status") return jsonResponse({ enabled: true });
      if (url === "/payment-account") return jsonResponse({ connected: true, provisioning: false });
      if (url === "/ai/messages" && method === "POST") {
        return jsonResponse({ conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: VALID_DRAFT });
      }
      if (url === "/communities" && method === "POST") {
        communityAttempts += 1;
        if (communityAttempts === 1) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return jsonResponse(CREATED_COMMUNITY, 201);
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    });

    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("halo");
    await screen.findByText("Berikut draf komunitasmu.");

    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));

    await screen.findByText(/Failed to fetch|Tidak dapat menghubungi server/);
    expect((screen.getByLabelText("Nama komunitas") as HTMLInputElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));

    await screen.findByText(/berhasil dibuat/);
    expect(calls.filter((c) => c.method === "POST" && c.url === "/communities").length).toBe(2);
  });

  it("does not silently discard tier errors when the community name is ALSO blank", async () => {
    stubFetch([
      AI_ENABLED,
      PAYMENT_CONNECTED,
      {
        method: "POST",
        path: "/ai/messages",
        body: { conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: VALID_DRAFT },
      },
    ]);
    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("halo");
    await screen.findByText("Berikut draf komunitasmu.");

    fireEvent.change(screen.getByLabelText("Nama komunitas"), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText("Harga paket 1 (Rupiah)"), { target: { value: "50000,50" } });
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));

    expect(await screen.findByText("Nama komunitas wajib diisi.")).toBeTruthy();
    // The tier price error must ALSO be visible — not discarded just because
    // the name check returned first.
    expect((await screen.findByTestId("error-tier-price-0")).textContent).toMatch(/bilangan bulat/);
  });

  it("keeps the earlier community's confirmation visible and requires an explicit, separate confirmation before a later draft can create a second community", async () => {
    const secondDraft = { ...VALID_DRAFT, name: "Kelas Bisnis Digital Lanjutan" };
    let messageAttempt = 0;
    const { calls } = recordingFetch((url, method, body) => {
      if (url === "/ai/status") return jsonResponse({ enabled: true });
      if (url === "/payment-account") return jsonResponse({ connected: true, provisioning: false });
      if (url === "/ai/messages" && method === "POST") {
        messageAttempt += 1;
        if (messageAttempt === 1) {
          return jsonResponse({ conversationId: "conv-1", reply: "Berikut draf pertama.", draft: VALID_DRAFT });
        }
        return jsonResponse({ conversationId: "conv-1", reply: "Berikut draf revisi.", draft: secondDraft });
      }
      if (url === "/communities" && method === "POST") {
        const communityBody = body as { name: string };
        return jsonResponse({ ...CREATED_COMMUNITY, name: communityBody.name }, 201);
      }
      if (url.endsWith("/tiers") && method === "POST") {
        return jsonResponse(
          { id: "tier-x", communityId: CREATED_COMMUNITY.id, ...(body as object), isActive: true },
          201
        );
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    });

    render();
    await screen.findByText(/Mulai obrolan/);

    await sendMessage("pesan pertama");
    await screen.findByText("Berikut draf pertama.");
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));
    await screen.findByText(/berhasil dibuat/);
    expect(calls.filter((c) => c.method === "POST" && c.url === "/communities").length).toBe(1);

    await sendMessage("ubah harga Pro jadi 200rb");
    await screen.findByText("Berikut draf revisi.");

    // The earlier confirmation and its link stay visible...
    expect(screen.getByTestId("duplicate-risk-notice")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Lihat komunitas" })).toBeTruthy();
    // ...and there is no plain "Buat komunitas ini" for one more click to
    // silently duplicate.
    expect(screen.queryAllByRole("button", { name: "Buat komunitas ini" }).length).toBe(0);
    const secondButton = screen.getByRole("button", { name: "Buat komunitas kedua ini" });
    expect((secondButton as HTMLButtonElement).disabled).toBe(true);

    // Still exactly one community — arriving at the new draft created nothing.
    expect(calls.filter((c) => c.method === "POST" && c.url === "/communities").length).toBe(1);

    fireEvent.click(screen.getByLabelText(/simpan draf ini sebagai komunitas KEDUA/i));
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas kedua ini" }));

    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST" && c.url === "/communities").length).toBe(2)
    );
  });

  it("disables the composer while a save is in flight, with Indonesian copy explaining why", async () => {
    let resolveCommunity: ((res: Response) => void) | null = null;
    const { calls } = recordingFetch((url, method) => {
      if (url === "/ai/status") return jsonResponse({ enabled: true });
      if (url === "/payment-account") return jsonResponse({ connected: true, provisioning: false });
      if (url === "/ai/messages" && method === "POST") {
        return jsonResponse({ conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: VALID_DRAFT });
      }
      if (url === "/communities" && method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveCommunity = resolve;
        });
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    });

    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("halo");
    await screen.findByText("Berikut draf komunitasmu.");

    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));

    await screen.findByTestId("save-in-flight-notice");
    expect((screen.getByLabelText("Pesan Anda") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Kirim" }) as HTMLButtonElement).disabled).toBe(true);

    resolveCommunity!(jsonResponse(CREATED_COMMUNITY, 201));

    await screen.findByText(/berhasil dibuat/);
    await waitFor(() => expect(screen.queryAllByTestId("save-in-flight-notice").length).toBe(0));
    expect((screen.getByLabelText("Pesan Anda") as HTMLTextAreaElement).disabled).toBe(false);
    expect(calls.filter((c) => c.method === "POST" && c.url === "/communities").length).toBe(1);
  });

  it("does not corrupt a new draft that arrives while an earlier save's tier request is still in flight (draft generation guard)", async () => {
    let resolveOldTier: ((res: Response) => void) | null = null;
    let messageAttempt = 0;
    const secondDraft = {
      name: "Kelas Menulis Kreatif",
      niche: "Menulis untuk pemula",
      description: "Komunitas menulis.",
      welcomeMessage: "Selamat datang di kelas menulis!",
      tiers: [{ name: "Starter", priceAmount: 30000, billingCycle: "monthly" }],
    };

    recordingFetch((url, method, body) => {
      if (url === "/ai/status") return jsonResponse({ enabled: true });
      if (url === "/payment-account") return jsonResponse({ connected: true, provisioning: false });
      if (url === "/ai/messages" && method === "POST") {
        messageAttempt += 1;
        if (messageAttempt === 1) {
          return jsonResponse({ conversationId: "conv-1", reply: "Berikut draf pertama.", draft: VALID_DRAFT });
        }
        return jsonResponse({ conversationId: "conv-1", reply: "Berikut draf kedua.", draft: secondDraft });
      }
      if (url === "/communities" && method === "POST") {
        return jsonResponse(CREATED_COMMUNITY, 201);
      }
      if (url === `/communities/${CREATED_COMMUNITY.id}/tiers` && method === "POST") {
        const tierBody = body as { name: string };
        if (tierBody.name === "Dasar") {
          // Held open — this is the old save's tier request still in flight
          // at the moment the new draft arrives.
          return new Promise<Response>((resolve) => {
            resolveOldTier = resolve;
          });
        }
        return jsonResponse({ id: "tier-x", communityId: CREATED_COMMUNITY.id, ...tierBody, isActive: true }, 201);
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    });

    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("pesan pertama");
    await screen.findByText("Berikut draf pertama.");

    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));
    await waitFor(() => expect(resolveOldTier).not.toBeNull());
    await screen.findByTestId("save-in-flight-notice");

    // BYPASS THE COMPOSER LOCK ON PURPOSE — the ruling requires this not to
    // matter: "do not rely on the composer lock alone... the stale write is a
    // correctness bug". Removing the attribute simulates the lock being
    // absent or defeated; the generation guard is what has to hold anyway.
    const textarea = screen.getByLabelText("Pesan Anda") as HTMLTextAreaElement;
    textarea.removeAttribute("disabled");
    fireEvent.change(textarea, { target: { value: "pesan kedua" } });
    const sendButton = screen.getByRole("button", { name: "Kirim" }) as HTMLButtonElement;
    sendButton.removeAttribute("disabled");
    fireEvent.click(sendButton);

    await screen.findByText("Berikut draf kedua.");
    // The new draft's own fields are immediately usable — not locked as
    // though they belonged to the old, still-running save.
    expect((screen.getByLabelText("Nama komunitas") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("Nama paket 1") as HTMLInputElement).value).toBe("Starter");
    expect((screen.getByLabelText("Nama paket 1") as HTMLInputElement).disabled).toBe(false);

    // NOW let the OLD save's held-open tier request resolve — wrapped in
    // `act` since resolving a bare promise (not a `fireEvent`) is what to
    // React looks like a state update from outside any event handler.
    await act(async () => {
      resolveOldTier!(
        jsonResponse(
          { id: "tier-old", communityId: CREATED_COMMUNITY.id, name: "Dasar", priceAmount: 50000, billingCycle: "monthly", isActive: true },
          201
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The stale write must not land on the NEW draft's tier 0 — no
    // "Sudah ditambahkan."/"Menyimpan..." bleeding through, and the field
    // must still be exactly as it arrived: editable, still named "Starter".
    expect(screen.queryAllByText("Sudah ditambahkan.").length).toBe(0);
    expect(screen.queryAllByText("Menyimpan...").length).toBe(0);
    expect((screen.getByLabelText("Nama paket 1") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("Nama paket 1") as HTMLInputElement).value).toBe("Starter");
    // The FIRST save's own confirmation is unaffected and not duplicated —
    // it does not re-render or re-fire just because the stale write bailed.
    expect(screen.getAllByText(/berhasil dibuat/).length).toBe(1);

    // "Dasar" had an UNKNOWN outcome at the instant the draft was replaced
    // (its request was still in flight) and went on to actually SUCCEED —
    // the sticky banner must never have claimed it as not-created. "Pro"
    // (never even attempted before the replacement) is legitimately
    // outstanding and IS named.
    const outstandingNotice = await screen.findByTestId("outstanding-tiers-notice");
    expect(outstandingNotice.textContent).not.toContain("Dasar");
    expect(outstandingNotice.textContent).toContain("Pro");
  });

  it("does not let a second 'Coba lagi paket yang gagal' click jump ahead of the first retry's own sequential loop", async () => {
    // BOTH tiers fail on the initial save, so the retry has TWO tiers queued
    // — this is what keeps "Coba lagi paket yang gagal" rendered (and, before
    // this fix, clickable) for the whole time the first retry's sequential
    // loop is still working through them: `anyTierFailed` only goes false
    // once every failed tier has been reached, and "Dasar" (index 0) is held
    // open here specifically so the loop never reaches "Pro" (index 1) on
    // its own within this test.
    let resolveDasarRetry: ((res: Response) => void) | null = null;
    let dasarAttempt = 0;
    let proAttempt = 0;

    recordingFetch((url, method, body) => {
      if (url === "/ai/status") return jsonResponse({ enabled: true });
      if (url === "/payment-account") return jsonResponse({ connected: true, provisioning: false });
      if (url === "/ai/messages" && method === "POST") {
        return jsonResponse({ conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: VALID_DRAFT });
      }
      if (url === "/communities" && method === "POST") {
        return jsonResponse(CREATED_COMMUNITY, 201);
      }
      if (url === `/communities/${CREATED_COMMUNITY.id}/tiers` && method === "POST") {
        const tierBody = body as { name: string };
        if (tierBody.name === "Dasar") {
          dasarAttempt += 1;
          if (dasarAttempt === 1) {
            return jsonResponse({ error: "priceAmount: too large" }, 400); // fails on the initial save
          }
          // Every retry attempt is held open.
          return new Promise<Response>((resolve) => {
            resolveDasarRetry = resolve;
          });
        }
        // "Pro"
        proAttempt += 1;
        if (proAttempt === 1) {
          return jsonResponse({ error: "priceAmount: too large" }, 400); // also fails on the initial save
        }
        return jsonResponse({ id: "tier-pro", communityId: CREATED_COMMUNITY.id, ...tierBody, isActive: true }, 201);
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    });

    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("halo");
    await screen.findByText("Berikut draf komunitasmu.");
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));

    await screen.findByTestId("error-tier-price-0");
    await screen.findByTestId("error-tier-price-1");

    const retryButton = await screen.findByRole("button", { name: "Coba lagi paket yang gagal" });
    fireEvent.click(retryButton);

    // "Dasar" (index 0) is attempted first by the retry's own sequential
    // loop and held open; "Pro" (index 1) has not been touched by THIS
    // retry at all yet.
    await waitFor(() => expect(dasarAttempt).toBe(2));
    expect(proAttempt).toBe(1); // still only its original, failed, initial-save attempt.

    // The button is disabled by now (the UI convention) — bypass it on
    // purpose, same reasoning as the generation-guard test: the internal
    // `saveInFlight` check, not the browser's native disabled-element
    // behaviour, is what actually has to stop this.
    const retryButtonAgain = screen.getByRole("button", { name: "Coba lagi paket yang gagal" }) as HTMLButtonElement;
    expect(retryButtonAgain.disabled).toBe(true);
    retryButtonAgain.removeAttribute("disabled");
    fireEvent.click(retryButtonAgain);

    // Give a wrongly-fired second call a chance to jump ahead and attempt
    // "Pro" out of turn, before the first call's own loop ever gets there.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(proAttempt).toBe(1); // UNCHANGED — the second call must bail immediately.

    // Now let the first call's own loop finish normally.
    await act(async () => {
      resolveDasarRetry!(
        jsonResponse(
          { id: "tier-dasar", communityId: CREATED_COMMUNITY.id, name: "Dasar", priceAmount: 50000, billingCycle: "monthly", isActive: true },
          201
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(proAttempt).toBe(2)); // exactly one real retry attempt, in order.
    expect(screen.queryAllByTestId("error-tier-price-0").length).toBe(0);
    expect(screen.queryAllByTestId("error-tier-price-1").length).toBe(0);
  });

  it("carries outstanding tier names into the sticky summary when a later draft replaces an incomplete save", async () => {
    const secondDraft = { ...VALID_DRAFT, name: "Kelas Bisnis Digital Lanjutan" };
    let messageAttempt = 0;
    recordingFetch((url, method, body) => {
      if (url === "/ai/status") return jsonResponse({ enabled: true });
      if (url === "/payment-account") return jsonResponse({ connected: true, provisioning: false });
      if (url === "/ai/messages" && method === "POST") {
        messageAttempt += 1;
        if (messageAttempt === 1) {
          return jsonResponse({ conversationId: "conv-1", reply: "Berikut draf pertama.", draft: VALID_DRAFT });
        }
        return jsonResponse({ conversationId: "conv-1", reply: "Berikut draf revisi.", draft: secondDraft });
      }
      if (url === "/communities" && method === "POST") {
        return jsonResponse(CREATED_COMMUNITY, 201);
      }
      if (url === `/communities/${CREATED_COMMUNITY.id}/tiers` && method === "POST") {
        const tierBody = body as { name: string };
        if (tierBody.name === "Dasar") {
          return jsonResponse({ id: "tier-1", communityId: CREATED_COMMUNITY.id, ...tierBody, isActive: true }, 201);
        }
        // "Pro" fails permanently in this test.
        return jsonResponse({ error: "priceAmount: too large" }, 400);
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    });

    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("pesan pertama");
    await screen.findByText("Berikut draf pertama.");
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));

    await screen.findByText("Sudah ditambahkan.");
    await screen.findByTestId("error-tier-price-1");
    // Let `saveInFlight` clear before sending the next message.
    await waitFor(() => expect((screen.getByLabelText("Pesan Anda") as HTMLTextAreaElement).disabled).toBe(false));

    await sendMessage("pesan kedua, revisi");
    await screen.findByText("Berikut draf revisi.");

    // The retry-failed-tiers button is gone with the old panel — this
    // sticky notice is the ONLY place that fact survives.
    expect(screen.queryAllByRole("button", { name: "Coba lagi paket yang gagal" }).length).toBe(0);
    const outstanding = await screen.findByTestId("outstanding-tiers-notice");
    expect(outstanding.textContent).toContain("Pro");
    expect(outstanding.textContent).toMatch(/halaman Paket/);
  });
});
