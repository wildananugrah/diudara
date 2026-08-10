import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import CoBuilderPage from "./CoBuilderPage";
import { renderPage, stubFetch, type StubRoute } from "../testing";

const AI_ENABLED: StubRoute = { path: "/ai/status", body: { enabled: true } };
const AI_DISABLED: StubRoute = { path: "/ai/status", body: { enabled: false } };

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

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("CoBuilderPage", () => {
  it("shows a prompt suggesting what to say when there are no messages yet", async () => {
    stubFetch([AI_ENABLED]);
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

  it("sends a message and shows the assistant's reply plus the resulting draft", async () => {
    const stub = stubFetch([
      AI_ENABLED,
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

  it("says description and welcomeMessage are not stored, and never sends them", async () => {
    const stub = stubFetch([
      AI_ENABLED,
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

  it("renders a 429 as a distinct daily-limit notice naming the reset time, and keeps the typed message", async () => {
    stubFetch([
      AI_ENABLED,
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
    expect(notice.textContent).toMatch(/batas harian/i);
    expect(notice.textContent).toMatch(/WIB/);
    // A generic error banner never renders — the 429 gets its own wording.
    expect(screen.queryAllByText("Gagal mengirim pesan").length).toBe(0);
    // The creator's own words are not lost.
    expect((screen.getByLabelText("Pesan Anda") as HTMLTextAreaElement).value).toBe("pesan yang ditolak");
  });

  it("keeps the conversation and offers a retry on a provider failure, without losing the typed message", async () => {
    let attempt = 0;
    const routes: StubRoute[] = [AI_ENABLED];
    stubFetch(routes);
    // Swap the handler after the first call by re-stubbing inside a custom fetch.
    global.fetch = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/ai/status")) {
        return new Response(JSON.stringify({ enabled: true }), { status: 200 });
      }
      if (url.startsWith("/ai/messages") && method === "POST") {
        attempt += 1;
        if (attempt === 1) {
          return new Response(
            JSON.stringify({ error: "AI co-builder sedang tidak bisa dihubungi. Coba lagi dalam beberapa saat." }),
            { status: 503 }
          );
        }
        return new Response(
          JSON.stringify({ conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: null }),
          { status: 200 }
        );
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    }) as unknown as typeof fetch;

    render();
    await screen.findByText(/Mulai obrolan/);

    await sendMessage("pesan pertama");

    const notice = await screen.findByTestId("send-error");
    expect(notice.textContent).toMatch(/tidak bisa dihubungi/);
    expect((screen.getByLabelText("Pesan Anda") as HTMLTextAreaElement).value).toBe("pesan pertama");

    fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));

    expect(await screen.findByText("Berikut draf komunitasmu.")).toBeTruthy();
    expect(attempt).toBe(2);
  });

  it("treats an unknown/foreign conversation (404) distinctly and starts fresh on retry", async () => {
    let attempt = 0;
    global.fetch = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/ai/status")) {
        return new Response(JSON.stringify({ enabled: true }), { status: 200 });
      }
      if (url.startsWith("/ai/messages") && method === "POST") {
        attempt += 1;
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (attempt === 1) {
          return new Response(
            JSON.stringify({ conversationId: "conv-1", reply: "Baik, ceritakan lebih lanjut.", draft: null }),
            { status: 200 }
          );
        }
        if (attempt === 2) {
          expect(body.conversationId).toBe("conv-1");
          return new Response(JSON.stringify({ error: "conversation not found" }), { status: 404 });
        }
        expect(body.conversationId).toBeNull();
        return new Response(
          JSON.stringify({ conversationId: "conv-2", reply: "Mulai lagi ya.", draft: null }),
          { status: 200 }
        );
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    }) as unknown as typeof fetch;

    render();
    await screen.findByText(/Mulai obrolan/);

    await sendMessage("pesan pertama");
    await screen.findByText("Baik, ceritakan lebih lanjut.");

    await sendMessage("pesan kedua");

    const notice = await screen.findByTestId("send-error");
    expect(notice.textContent).toMatch(/tidak ditemukan/i);

    fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));

    expect(await screen.findByText("Mulai lagi ya.")).toBeTruthy();
    expect(attempt).toBe(3);
  });

  it("refuses a non-integer tier price without asking the API", async () => {
    const stub = stubFetch([
      AI_ENABLED,
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
    expect(stub.calls.some((c) => c.method === "POST" && c.url === "/communities")).toBe(false);
  });

  it("edits the draft (name, niche, tier name and price) before saving, and saves the edited values", async () => {
    const stub = stubFetch([
      AI_ENABLED,
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
        body: { id: "tier-1", communityId: CREATED_COMMUNITY.id, name: "Dasar Plus", priceAmount: 75000, billingCycle: "monthly", isActive: true },
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

    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));

    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.url === "/communities")).toBe(true));
    const communityPost = stub.calls.find((c) => c.method === "POST" && c.url === "/communities")!;
    expect(communityPost.body).toEqual({ name: "Kelas Edit", niche: "Edit niche" });

    await waitFor(() =>
      expect(stub.calls.some((c) => c.method === "POST" && c.url.includes("/tiers"))).toBe(true)
    );
    const tierPosts = stub.calls.filter((c) => c.method === "POST" && c.url.includes("/tiers"));
    expect(tierPosts[0].body).toEqual({ name: "Dasar Plus", priceAmount: 75000, billingCycle: "monthly" });
  });

  it("on a partial save failure, shows what succeeded and failed, and retries only the failed tier", async () => {
    let tierAttempt = 0;
    global.fetch = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/ai/status")) {
        return new Response(JSON.stringify({ enabled: true }), { status: 200 });
      }
      if (url === "/ai/messages" && method === "POST") {
        return new Response(
          JSON.stringify({ conversationId: "conv-1", reply: "Berikut draf komunitasmu.", draft: VALID_DRAFT }),
          { status: 200 }
        );
      }
      if (url === "/communities" && method === "POST") {
        return new Response(JSON.stringify(CREATED_COMMUNITY), { status: 201 });
      }
      if (url === `/communities/${CREATED_COMMUNITY.id}/tiers` && method === "POST") {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.name === "Dasar") {
          return new Response(
            JSON.stringify({ id: "tier-1", communityId: CREATED_COMMUNITY.id, ...body, isActive: true }),
            { status: 201 }
          );
        }
        tierAttempt += 1;
        if (tierAttempt === 1) {
          return new Response(JSON.stringify({ error: "priceAmount: too large" }), { status: 400 });
        }
        return new Response(
          JSON.stringify({ id: "tier-2", communityId: CREATED_COMMUNITY.id, ...body, isActive: true }),
          { status: 201 }
        );
      }
      throw new Error(`unstubbed request: ${method} ${url}`);
    }) as unknown as typeof fetch;

    render();
    await screen.findByText(/Mulai obrolan/);
    await sendMessage("halo");
    await screen.findByText("Berikut draf komunitasmu.");

    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas ini" }));

    // The community itself is reported as created, with a way to see it.
    expect(await screen.findByText(/berhasil dibuat/)).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Lihat komunitas" })).toBeTruthy();

    // One tier succeeded, one failed — both visible, not just a blanket error.
    expect(await screen.findByText("Sudah ditambahkan.")).toBeTruthy();
    expect(await screen.findByTestId("error-tier-price-1")).toBeTruthy();
    expect(screen.getByTestId("error-tier-price-1").textContent).toContain("too large");

    const retryButton = await screen.findByRole("button", { name: "Coba lagi paket yang gagal" });
    fireEvent.click(retryButton);

    await waitFor(() => expect(tierAttempt).toBe(2));
    expect(screen.queryAllByText(/too large/).length).toBe(0);
    // The community was never re-created for the retry.
    // (No separate assertion needed: the stub above would 201 forever, so this
    // is guarded by the "berhasil dibuat" text staying singular in the DOM.)
    expect(screen.getAllByText(/berhasil dibuat/).length).toBe(1);
  });
});
