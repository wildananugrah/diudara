import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import FollowButton from "./FollowButton";
import { setUserSession } from "./apiClient";

const USER = { id: "user-1", handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderButton(props: Parameters<typeof FollowButton>[0]) {
  return render(
    <MemoryRouter>
      <FollowButton {...props} />
    </MemoryRouter>
  );
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

describe("FollowButton", () => {
  it('renders "Masuk untuk mengikuti", linking to /masuk, when viewerFollows is null (signed out)', () => {
    renderButton({ handle: "budi", viewerFollows: null });

    const link = screen.getByRole("link", { name: "Masuk untuk mengikuti" });
    expect(link.getAttribute("href")).toBe("/masuk");
  });

  it('renders "Ikuti" when viewerFollows is false', () => {
    setUserSession("jwt-abc", USER);
    renderButton({ handle: "budi", viewerFollows: false });

    expect(screen.getByRole("button", { name: "Ikuti" })).toBeTruthy();
  });

  it('renders "Mengikuti" when viewerFollows is true', () => {
    setUserSession("jwt-abc", USER);
    renderButton({ handle: "budi", viewerFollows: true });

    expect(screen.getByRole("button", { name: "Mengikuti" })).toBeTruthy();
  });

  it('tapping "Ikuti" calls POST .../follow and flips to "Mengikuti"', async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ following: true });
    }) as unknown as typeof fetch;

    renderButton({ handle: "budi", viewerFollows: false });
    fireEvent.click(screen.getByRole("button", { name: "Ikuti" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Mengikuti" })).toBeTruthy();
    });
    expect(calls[0]!.url).toBe("/users/budi/follow");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it('tapping "Mengikuti" calls DELETE .../follow and flips to "Ikuti"', async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ following: false });
    }) as unknown as typeof fetch;

    renderButton({ handle: "budi", viewerFollows: true });
    fireEvent.click(screen.getByRole("button", { name: "Mengikuti" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Ikuti" })).toBeTruthy();
    });
    expect(calls[0]!.url).toBe("/users/budi/follow");
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("reverts to Ikuti when the follow call fails", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () => jsonResponse({ error: "server error" }, 500)) as unknown as typeof fetch;

    renderButton({ handle: "budi", viewerFollows: false });
    fireEvent.click(screen.getByRole("button", { name: "Ikuti" }));

    // Optimistic flip happens immediately...
    expect(screen.getByRole("button", { name: "Mengikuti" })).toBeTruthy();

    // ...then reverts once the failed request resolves.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Ikuti" })).toBeTruthy();
    });
  });

  it("is disabled while a request is in flight, and re-enabled once it resolves", async () => {
    setUserSession("jwt-abc", USER);
    let resolveFetch: (res: Response) => void = () => {};
    global.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;

    renderButton({ handle: "budi", viewerFollows: false });
    fireEvent.click(screen.getByRole("button", { name: "Ikuti" }));

    const button = screen.getByRole("button", { name: "Mengikuti" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    resolveFetch(jsonResponse({ following: true }));

    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Mengikuti" }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("renders nothing at all on your own profile, even though viewerFollows is false there, not null", () => {
    setUserSession("jwt-abc", USER);
    renderButton({ handle: "wildan", viewerFollows: false });

    expect(screen.queryAllByRole("button").length).toBe(0);
    expect(screen.queryAllByRole("link").length).toBe(0);
  });

  it("is absent on your own profile regardless of handle case", () => {
    setUserSession("jwt-abc", USER);
    renderButton({ handle: "WILDAN", viewerFollows: false });

    expect(screen.queryAllByRole("button").length).toBe(0);
  });

  // Review round 2, Minor: the case fix above only varies the TARGET
  // handle's case, so a comparison that normalised only that side (leaving
  // the session's own cached handle un-lowercased) would still pass it. This
  // varies the SESSION side instead.
  it("is absent on your own profile even when the session's cached handle has different case than the prop", () => {
    setUserSession("jwt-abc", { ...USER, handle: "WILDAN" });
    renderButton({ handle: "wildan", viewerFollows: false });

    expect(screen.queryAllByRole("button").length).toBe(0);
  });

  it("is absent on your own profile even if the handle prop carries a leading @", () => {
    setUserSession("jwt-abc", USER);
    renderButton({ handle: "@wildan", viewerFollows: false });

    expect(screen.queryAllByRole("button").length).toBe(0);
  });

  it("renders the toggle normally when signed out is false but the handle differs from the viewer's own", () => {
    setUserSession("jwt-abc", USER);
    renderButton({ handle: "budi", viewerFollows: false });

    expect(screen.getByRole("button", { name: "Ikuti" })).toBeTruthy();
  });
});
