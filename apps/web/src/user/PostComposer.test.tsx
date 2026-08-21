import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import PostComposer from "./PostComposer";
import {
  loadPostImageLimit,
  resetPostImageLimitForTesting,
  UserApiError,
  type MediaView,
} from "./apiClient";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  // The advisory limit is module state for the life of the process — see
  // `resetPostImageLimitForTesting`'s own docstring. Without this, a test that
  // sets it to 2 decides what the next test's composer allows.
  resetPostImageLimitForTesting();
  cleanup();
});

/**
 * Every length assertion in this file uses the LITERAL `1000`, never
 * `MAX_POST_BODY_LENGTH`. See that constant's own docstring in
 * `packages/shared/src/auth.schema.ts`: a test that asserts against the same
 * symbol the production code reads moves in lockstep with any regression to it
 * and passes vacuously. Step 5 of this task changes the constant to `999` and
 * requires BOTH `apps/api` and `apps/web` to go red; these are the web half.
 */
const LIMIT = 1000;

function renderComposer(props: Partial<Parameters<typeof PostComposer>[0]> = {}) {
  const onSubmit = props.onSubmit ?? mock(async () => {});
  const { container } = render(
    <PostComposer submitLabel="Kirim" {...props} onSubmit={onSubmit} />
  );
  return { onSubmit, container };
}

/**
 * Submits the FORM directly, bypassing the submit button entirely.
 *
 * This is the only way to reach `handleSubmit`'s own `if (!canSubmit) return;`
 * guard from a test: every other path goes through a button carrying
 * `disabled`, which stops the event before the handler runs. Fix round 1 —
 * the reviewer deleted that guard and the whole web suite stayed at 598/0,
 * because nothing exercised what it is actually for. A real browser reaches it
 * via Enter in the textarea and via `form.requestSubmit()`.
 */
function submitForm(container: HTMLElement): void {
  fireEvent.submit(container.querySelector("form")!);
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement;
}

function submitButton(label = "Kirim"): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

function type(value: string): void {
  fireEvent.change(textarea(), { target: { value } });
}

/** Gives a promise chain a chance to run before an ABSENCE is asserted. */
function settle(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("PostComposer — what may be sent", () => {
  it("disables the submit button when the box is empty", () => {
    renderComposer();

    expect(submitButton().disabled).toBe(true);
  });

  it("disables the submit button when the box holds only whitespace", () => {
    renderComposer();

    type("   \n\t  ");

    // The counter proves the disable is measuring the TRIMMED length rather
    // than merely failing to notice the change at all.
    expect(screen.getByText("0/1000")).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("enables the submit button once there is non-whitespace text", () => {
    renderComposer();

    type("  halo  ");

    expect(submitButton().disabled).toBe(false);
  });

  /**
   * Reachable only through `initialBody`, which is deliberately NOT clamped —
   * see `PostComposerProps.initialBody`'s own docstring for why truncating an
   * existing post the moment somebody taps Edit would be worse than refusing to
   * save it. Typing cannot reach this state, because `onChange` slices.
   */
  it("disables the submit button when the body is over the limit — LITERAL 1001", () => {
    renderComposer({ initialBody: "a".repeat(1001) });

    expect(screen.getByText("1001/1000")).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("enables the submit button at EXACTLY the limit — LITERAL 1000", () => {
    renderComposer({ initialBody: "a".repeat(1000) });

    expect(screen.getByText("1000/1000")).toBeTruthy();
    expect(submitButton().disabled).toBe(false);
  });
});

describe("PostComposer — the limit is bounded twice", () => {
  it("shows 0/1000 initially — the LITERAL 1000, never the constant", () => {
    renderComposer();

    expect(screen.getByText("0/1000")).toBeTruthy();
  });

  it("sets maxLength on the textarea to the LITERAL 1000", () => {
    renderComposer();

    expect(textarea().getAttribute("maxlength")).toBe("1000");
  });

  /**
   * `maxLength` is what a real browser applies to typing and pasting; this
   * `.slice()` is what bounds every OTHER way a value can arrive, including
   * `fireEvent.change`, which ignores the attribute entirely. Both are
   * `MAX_POST_BODY_LENGTH` in the source and both are asserted as `1000` here.
   */
  it("clamps a programmatically-set over-long value to 1000 characters", () => {
    renderComposer();

    type("b".repeat(1500));

    expect(textarea().value.length).toBe(LIMIT);
    expect(screen.getByText("1000/1000")).toBeTruthy();
  });

  it("counts the TRIMMED length, matching what the server validates", () => {
    renderComposer();

    type("   halo   ");

    expect(screen.getByText("4/1000")).toBeTruthy();
  });

  it("renders the placeholder the design asks for", () => {
    renderComposer();

    expect(textarea().getAttribute("placeholder")).toBe("Apa yang terjadi?");
  });
});

describe("PostComposer — submitting", () => {
  it("hands onSubmit the TRIMMED body, not what is literally in the box", async () => {
    const onSubmit = mock(async () => {});
    renderComposer({ onSubmit });

    type("  halo dunia  ");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    // Two arguments since Task 8: the body, and the ids of the attached photos
    // — an empty list when there are none, never `undefined`.
    expect(onSubmit).toHaveBeenCalledWith("halo dunia", []);
  });

  it("clears the box on a successful submit", async () => {
    renderComposer();

    type("halo");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(textarea().value).toBe("");
    });
    expect(screen.getByText("0/1000")).toBeTruthy();
  });

  /**
   * The one that matters most. Losing what somebody wrote is the worst outcome
   * available here — the same rule `PostFeed` follows when a failed "load more"
   * leaves the already-loaded posts on screen.
   */
  it("KEEPS the text when the submit fails, and shows Bahasa copy", async () => {
    const onSubmit = mock(async () => {
      throw new UserApiError("internal server error", 500);
    });
    renderComposer({ onSubmit });

    type("naskah yang panjang");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Kiriman gagal disimpan. Server sedang bermasalah. Coba lagi sebentar lagi."
      );
    });
    // The point of the test, asserted AFTER the alert has certainly rendered so
    // it cannot be skipped by an earlier failure.
    expect(textarea().value).toBe("naskah yang panjang");
  });

  it("never surfaces the server's own error text", async () => {
    const onSubmit = mock(async () => {
      throw new UserApiError("body must be at most 1000 characters", 400);
    });
    renderComposer({ onSubmit });

    type("halo");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Kiriman gagal disimpan. Permintaan tidak dapat diproses. Coba lagi."
      );
    });
    expect(screen.queryAllByText(/must be at most/).length).toBe(0);
  });

  it("shows Bahasa copy for a network failure too, not only a server response", async () => {
    const onSubmit = mock(async () => {
      throw new TypeError("Failed to fetch");
    });
    renderComposer({ onSubmit });

    type("halo");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Kiriman gagal disimpan. Tidak dapat menghubungi server. Coba lagi."
      );
    });
    expect(screen.queryAllByText(/Failed to fetch/).length).toBe(0);
  });

  it("clears a previous error once a later submit succeeds", async () => {
    let fail = true;
    const onSubmit = mock(async () => {
      if (fail) throw new UserApiError("internal server error", 500);
    });
    renderComposer({ onSubmit });

    type("halo");
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    fail = false;
    type("halo lagi");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(textarea().value).toBe("");
    });
    expect(screen.queryAllByRole("alert").length).toBe(0);
  });

  it("disables the button while a submit is in flight, and a second click fires nothing", async () => {
    let release: () => void = () => {};
    const onSubmit = mock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    renderComposer({ onSubmit });

    type("halo");
    fireEvent.click(submitButton());

    expect(submitButton().disabled).toBe(true);

    fireEvent.click(submitButton());
    fireEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => {
      expect(textarea().value).toBe("");
    });
  });

  /**
   * Fix round 1. The three tests below reach `handleSubmit`'s own guard, which
   * `disabled` alone hides — see `submitForm`'s docstring. Without the guard,
   * `onSubmit("")` reaches the API and the server answers a 400 the composer
   * then has to explain, for a form the UI already said could not be sent.
   */
  it("sends nothing when the FORM is submitted with an empty box", async () => {
    const { onSubmit, container } = renderComposer();

    submitForm(container);
    await settle();

    expect(onSubmit).toHaveBeenCalledTimes(0);
  });

  it("sends nothing when the FORM is submitted with a whitespace-only box", async () => {
    const { onSubmit, container } = renderComposer();

    type("   \n  ");
    submitForm(container);
    await settle();

    expect(onSubmit).toHaveBeenCalledTimes(0);
  });

  it("sends nothing when the FORM is submitted again mid-flight", async () => {
    let release: () => void = () => {};
    const onSubmit = mock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const { container } = renderComposer({ onSubmit });

    type("halo");
    submitForm(container);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    submitForm(container);
    submitForm(container);
    await settle();

    expect(onSubmit).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => {
      expect(textarea().value).toBe("");
    });
  });

  it("sends nothing when the FORM is submitted with an over-limit body", async () => {
    const { onSubmit, container } = renderComposer({ initialBody: "a".repeat(1001) });

    submitForm(container);
    await settle();

    expect(onSubmit).toHaveBeenCalledTimes(0);
  });
});

describe("PostComposer — the edit shape", () => {
  it("pre-fills the box from initialBody and counts it", () => {
    renderComposer({ initialBody: "isi lama", submitLabel: "Simpan" });

    expect(textarea().value).toBe("isi lama");
    expect(screen.getByText("8/1000")).toBeTruthy();
  });

  it("uses the caller's submitLabel rather than a hard-coded one", () => {
    renderComposer({ initialBody: "isi lama", submitLabel: "Simpan" });

    expect(screen.getByRole("button", { name: "Simpan" })).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Kirim" }).length).toBe(0);
  });

  it("renders no Batal button when there is no onCancel", () => {
    renderComposer();

    expect(screen.queryAllByRole("button", { name: "Batal" }).length).toBe(0);
  });

  it("renders Batal and calls onCancel when one is given", () => {
    const onCancel = mock(() => {});
    renderComposer({ initialBody: "isi lama", submitLabel: "Simpan", onCancel });

    fireEvent.click(screen.getByRole("button", { name: "Batal" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------ *
 * Task 8 — the media strip.
 *
 * `global.fetch` is replaced directly and `apiClient`'s real `uploadMedia`
 * runs against it, exactly as `BerandaPage.test.tsx` does: no module mocking,
 * so these tests exercise the real request shape rather than a stand-in.
 *
 * **No DOM node reaches any assertion here** — counts, strings and booleans
 * only. See `MediaStrip.test.tsx`'s own note for the measured reason.
 * ------------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function mockFetch(handler: FetchHandler): Call[] {
  const calls: Call[] = [];
  global.fetch = mock(async (url: string, init: RequestInit | undefined) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return calls;
}

/** One successful upload per call, with ids `media-1`, `media-2`, ... in order. */
function mockSuccessfulUploads(): Call[] {
  let issued = 0;
  return mockFetch(() => {
    issued += 1;
    return jsonResponse({ id: `media-${issued}`, width: 800, height: 600 }, 201);
  });
}

/**
 * Sets the advisory limit the way the app does — through `GET /users/limits`
 * — rather than by poking at module state, so what these tests configure is
 * what `App` configures at boot.
 */
async function setLimitTo(max: number): Promise<void> {
  const before = global.fetch;
  global.fetch = mock(async () => jsonResponse({ maxPostImages: max })) as unknown as typeof fetch;
  await loadPostImageLimit();
  global.fetch = before;
}

function jpeg(name: string, bytes = 3): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
}

/** Just over the API's own `MAX_UPLOAD_BYTES`, written as the LITERAL 10 MB. */
function tooBigJpeg(name: string): File {
  return jpeg(name, 10 * 1024 * 1024 + 1);
}

/** Chooses arbitrary `File`s in the picker, for the cases `choose(...names)` cannot build. */
function chooseFiles(...files: File[]): void {
  fireEvent.change(screen.getByTestId("media-picker"), { target: { files } });
}

function notices(): (string | null)[] {
  return screen.queryAllByRole("alert").map((node) => node.textContent);
}

/** Chooses files in the strip's picker, as tapping "Tambah foto" and picking would. */
function choose(...names: string[]): void {
  fireEvent.change(screen.getByTestId("media-picker"), {
    target: { files: names.map((name) => jpeg(name)) },
  });
}

function addButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Tambah foto" }) as HTMLButtonElement;
}

function previewSources(): (string | null)[] {
  return screen.queryAllByRole("img").map((img) => img.getAttribute("src"));
}

/**
 * Waits for every upload started so far to have LANDED (or failed).
 *
 * The preview appears the instant a file is chosen — it is a local object URL,
 * not the server's copy — so waiting for an `<img>` proves only that the strip
 * rendered, not that the id exists. The progress indicator is the honest
 * signal: one per in-flight upload, and gone in both outcomes.
 */
async function uploadsSettled(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryAllByRole("progressbar").length).toBe(0);
  });
}

function media(id: string): MediaView {
  return { id, width: 800, height: 600 };
}

describe("PostComposer — a photo is a caption's illustration (§7.1)", () => {
  /**
   * **The trap this section exists for.** The instinct when adding a media
   * strip is to widen the send condition to "there is text OR there is an
   * image". Body text stays required — a post carrying only images is a 400 —
   * so a caption-less photo must be refused by the button, quietly, rather than
   * by the server with an error the person has to decode.
   */
  it("an attached photo NEVER enables Kirim on its own", async () => {
    mockSuccessfulUploads();
    renderComposer();

    choose("foto.jpg");
    await uploadsSettled();

    // The photo really did land — this is not a disabled button for want of an
    // upload — and Kirim is STILL disabled, because the box is empty.
    expect(previewSources().length).toBe(1);
    expect(submitButton().disabled).toBe(true);
  });

  it("enables Kirim once there is text, with the photo already attached", async () => {
    mockSuccessfulUploads();
    renderComposer();

    choose("foto.jpg");
    await uploadsSettled();
    type("halo");

    expect(previewSources().length).toBe(1);
    expect(submitButton().disabled).toBe(false);
  });

  it("still refuses a whitespace-only caption with a photo attached", async () => {
    mockSuccessfulUploads();
    renderComposer();

    choose("foto.jpg");
    await uploadsSettled();
    type("    ");

    expect(submitButton().disabled).toBe(true);
  });
});

describe("PostComposer — uploads in flight", () => {
  it("Kirim is disabled while an upload is still in flight", async () => {
    let release: ((response: Response) => void) | null = null;
    mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    renderComposer();

    type("halo");
    expect(submitButton().disabled).toBe(false);

    choose("foto.jpg");

    // The post cannot reference an id that does not exist yet.
    expect(submitButton().disabled).toBe(true);
    expect(screen.getAllByRole("progressbar").length).toBe(1);

    await act(async () => {
      release!(jsonResponse({ id: "media-1", width: 800, height: 600 }, 201));
    });

    await waitFor(() => {
      expect(submitButton().disabled).toBe(false);
    });
    expect(screen.queryAllByRole("progressbar").length).toBe(0);
  });

  it("sends the ids of the attached photos, in order, alongside the trimmed body", async () => {
    mockSuccessfulUploads();
    const onSubmit = mock(async () => {});
    renderComposer({ onSubmit });

    choose("satu.jpg", "dua.jpg");
    await uploadsSettled();
    type("  halo  ");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith("halo", ["media-1", "media-2"]);
  });

  it("does not send a photo that was removed before Kirim", async () => {
    mockSuccessfulUploads();
    const onSubmit = mock(async () => {});
    renderComposer({ onSubmit });

    choose("satu.jpg", "dua.jpg");
    await uploadsSettled();
    expect(previewSources().length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Hapus foto 1" }));
    // One preview left, and it is the one that stays on the post.
    expect(previewSources().length).toBe(1);
    type("halo");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith("halo", ["media-2"]);
  });

  it("clears the strip along with the box once the post is sent", async () => {
    mockSuccessfulUploads();
    renderComposer();

    choose("satu.jpg");
    await uploadsSettled();
    type("halo");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(textarea().value).toBe("");
    });
    expect(previewSources().length).toBe(0);
    expect(screen.getByText("0/5 foto")).toBeTruthy();
  });

  /**
   * The same rule the body text follows: a failed send keeps everything the
   * author put into this composer. Dropping the photos would make them pick
   * and re-upload every one of them to retry a post they already wrote.
   */
  it("KEEPS the attached photos when the send itself fails", async () => {
    mockSuccessfulUploads();
    const onSubmit = mock(async () => {
      throw new UserApiError("internal server error", 500);
    });
    renderComposer({ onSubmit });

    choose("satu.jpg");
    await uploadsSettled();
    type("naskah");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Kiriman gagal disimpan. Server sedang bermasalah. Coba lagi sebentar lagi."
      );
    });
    expect(textarea().value).toBe("naskah");
    expect(previewSources().length).toBe(1);
  });
});

describe("PostComposer — a failed upload", () => {
  it("a failed upload marks that image, keeps the text, and offers a retry", async () => {
    mockFetch(() => jsonResponse({ error: "internal server error" }, 500));
    renderComposer();

    type("naskah yang panjang");
    choose("foto.jpg");

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Foto gagal diunggah. Server sedang bermasalah. Coba lagi sebentar lagi."
      );
    });
    // The text is untouched — losing somebody's caption because an upload
    // failed is the worst outcome available here.
    expect(textarea().value).toBe("naskah yang panjang");
    expect(screen.getAllByRole("button", { name: "Coba lagi unggah foto 1" }).length).toBe(1);
  });

  it("marks ONLY the image that failed", async () => {
    let attempt = 0;
    mockFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ id: "media-1", width: 800, height: 600 }, 201)
        : jsonResponse({ error: "internal server error" }, 500);
    });
    renderComposer();

    choose("satu.jpg", "dua.jpg");

    await waitFor(() => {
      expect(screen.getAllByRole("alert").length).toBe(1);
    });
    expect(screen.getAllByRole("button", { name: /^Coba lagi/ }).length).toBe(1);
    expect(screen.getByRole("button", { name: "Coba lagi unggah foto 2" })).toBeTruthy();
  });

  it("re-uploads that one image when the retry is pressed, and clears its failure", async () => {
    let attempt = 0;
    const calls = mockFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ error: "internal server error" }, 500)
        : jsonResponse({ id: "media-7", width: 800, height: 600 }, 201);
    });
    const onSubmit = mock(async () => {});
    renderComposer({ onSubmit });

    type("halo");
    choose("foto.jpg");
    await waitFor(() => {
      expect(screen.getAllByRole("alert").length).toBe(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Coba lagi unggah foto 1" }));

    await uploadsSettled();
    expect(screen.queryAllByRole("alert").length).toBe(0);
    // The same file went back up, to the same route, rather than a fresh pick.
    expect(calls.map((call) => call.url)).toEqual(["/users/media", "/users/media"]);
    expect(((calls[1]!.init!.body as FormData).get("file") as File).name).toBe("foto.jpg");

    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith("halo", ["media-7"]);
  });

  /**
   * A failure is not a hostage. Blocking Kirim on a photo that keeps failing
   * would leave the author unable to post the caption they already wrote, and
   * the failure is visible on the strip — with a retry and a remove — so
   * sending without it is a choice they can see, not a silent loss.
   */
  it("does not block Kirim, and sends only the photos that landed", async () => {
    let attempt = 0;
    mockFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ id: "media-1", width: 800, height: 600 }, 201)
        : jsonResponse({ error: "internal server error" }, 500);
    });
    const onSubmit = mock(async () => {});
    renderComposer({ onSubmit });

    choose("satu.jpg", "dua.jpg");
    await uploadsSettled();
    expect(screen.getAllByRole("alert").length).toBe(1);
    type("halo");

    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith("halo", ["media-1"]);
  });

  /**
   * Fix round 1, Important 1, and re-pinned by the final whole-branch review:
   * the refusal now carries a machine-readable `code` and the copy branches on
   * it rather than on the bare 400 (a 45-megapixel photo was about to be
   * described as an unsupported iPhone format). The person is told WHICH thing
   * to change, and HEIC is named because it is what an iPhone hands over by
   * default. "Coba lagi" alone sent them round a loop that retrying cannot
   * break.
   */
  it("says what is actually wrong on a format refusal, and never the server's own text", async () => {
    mockFetch(() =>
      jsonResponse(
        {
          error: "Format foto tidak didukung. Gunakan JPG, PNG, atau WebP.",
          code: "media_unsupported_format",
        },
        400
      )
    );
    renderComposer();

    choose("foto.heic");

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Foto gagal diunggah. Format ini tidak didukung. Gunakan JPG, PNG, atau WebP — foto iPhone (HEIC) belum didukung."
      );
    });
    // The API answers Bahasa here, which makes it the easiest place to justify
    // rendering `err.message`. The rule is that a screen never prints the wire's
    // sentence, whatever language it is in.
    expect(screen.queryAllByText(/Format foto tidak didukung/).length).toBe(0);
  });

  /**
   * **The proxy's 413, end to end through the composer.** nginx's default
   * `client_max_body_size` is 1 MB and a phone photo is 2–5, so on a box whose
   * proxy has not been configured this is the failure EVERY real upload hits —
   * and it arrives as an HTML error page, not JSON, carrying no code at all.
   * Before the final whole-branch review it read "Coba lagi", which is the
   * retry-forever loop this whole module exists to kill.
   */
  it("says a photo is too big when the PROXY refuses it, not 'coba lagi'", async () => {
    mockFetch(
      () =>
        new Response("<html><head><title>413 Request Entity Too Large</title></head></html>", {
          status: 413,
          headers: { "Content-Type": "text/html" },
        })
    );
    renderComposer();

    choose("foto.jpg");

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Foto gagal diunggah. Foto terlalu besar. Pilih foto berukuran di bawah 10 MB."
      );
    });
  });
});

describe("PostComposer — the limit (spec §6)", () => {
  it("the add button disables at the limit — LITERAL 2", async () => {
    await setLimitTo(2);
    mockSuccessfulUploads();
    renderComposer();

    choose("satu.jpg");
    await uploadsSettled();
    expect(addButton().disabled).toBe(false);

    choose("dua.jpg");
    await uploadsSettled();

    expect(addButton().disabled).toBe(true);
    expect(screen.getByText("2/2 foto")).toBeTruthy();
  });

  it("attaches only as many of a multi-pick as there is room for", async () => {
    await setLimitTo(2);
    mockSuccessfulUploads();
    renderComposer();

    choose("satu.jpg", "dua.jpg", "tiga.jpg");
    await uploadsSettled();

    expect(screen.getByText("2/2 foto")).toBeTruthy();
    expect(previewSources().length).toBe(2);
  });

  it("frees a slot again when an image is removed", async () => {
    await setLimitTo(2);
    mockSuccessfulUploads();
    renderComposer();

    choose("satu.jpg", "dua.jpg");
    await uploadsSettled();
    expect(addButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Hapus foto 1" }));

    expect(addButton().disabled).toBe(false);
    expect(screen.getByText("1/2 foto")).toBeTruthy();
  });

  /**
   * Spec §6, verbatim: "a composer that refuses to open because a config
   * endpoint is down would be a worse product than one that occasionally offers
   * a sixth photo and is told no." The fallback is the LITERAL 5.
   */
  it("falls back to a default limit when GET /users/limits fails, and stays usable", async () => {
    const before = global.fetch;
    global.fetch = mock(async () =>
      jsonResponse({ error: "internal server error" }, 500)
    ) as unknown as typeof fetch;
    await loadPostImageLimit();
    global.fetch = before;

    mockSuccessfulUploads();
    const onSubmit = mock(async () => {});
    renderComposer({ onSubmit });

    // The composer opened, the strip works, and the built-in 5 is in force.
    expect(screen.getByText("0/5 foto")).toBeTruthy();
    expect(addButton().disabled).toBe(false);

    choose("satu.jpg");
    await uploadsSettled();
    expect(screen.getByText("1/5 foto")).toBeTruthy();
    type("halo");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith("halo", ["media-1"]);
  });
});

describe("PostComposer — the edit shape carries images too (spec §7)", () => {
  it("the EDIT composer is seeded with the post's existing images", () => {
    renderComposer({
      initialBody: "isi lama",
      initialMedia: [media("media-1"), media("media-2")],
      submitLabel: "Simpan",
      onCancel: () => {},
    });

    expect(previewSources()).toEqual([
      "/users/media/media-1/thumb",
      "/users/media/media-2/thumb",
    ]);
    expect(screen.getByText("2/5 foto")).toBeTruthy();
  });

  it("each seeded image is removable, and Simpan sends the list that is left", async () => {
    const onSubmit = mock(async () => {});
    renderComposer({
      initialBody: "isi lama",
      initialMedia: [media("media-1"), media("media-2")],
      submitLabel: "Simpan",
      onSubmit,
      onCancel: () => {},
    });

    fireEvent.click(screen.getByRole("button", { name: "Hapus foto 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    // The COMPLETE desired list (spec §5.2), not a delta.
    expect(onSubmit).toHaveBeenCalledWith("isi lama", ["media-2"]);
  });

  it("sends an EMPTY list when every image is removed — not an omitted one", async () => {
    const onSubmit = mock(async () => {});
    renderComposer({
      initialBody: "isi lama",
      initialMedia: [media("media-1")],
      submitLabel: "Simpan",
      onSubmit,
      onCancel: () => {},
    });

    fireEvent.click(screen.getByRole("button", { name: "Hapus foto 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith("isi lama", []);
  });

  it("adds more photos to an existing post, up to the limit", async () => {
    await setLimitTo(2);
    mockSuccessfulUploads();
    const onSubmit = mock(async () => {});
    renderComposer({
      initialBody: "isi lama",
      // A different id from anything `mockSuccessfulUploads` issues, so the
      // post's own image and the newly uploaded one are told apart.
      initialMedia: [media("media-9")],
      submitLabel: "Simpan",
      onSubmit,
      onCancel: () => {},
    });

    choose("baru.jpg");
    await uploadsSettled();
    expect(addButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    // The post's existing image first, then the one added during the edit.
    expect(onSubmit).toHaveBeenCalledWith("isi lama", ["media-9", "media-1"]);
  });
});

/**
 * Batal is the page's business — the composer only reports it — so the discard
 * is proved the way a page does it: the edit composer is unmounted and opened
 * again, and what comes back is the POST's own images, never what the abandoned
 * edit had added. The upload that was abandoned stays unclaimed and is swept by
 * §8, exactly like any other orphan.
 */
function EditHost({
  post,
  onSubmit,
}: {
  post: { body: string; media: MediaView[] };
  onSubmit: (body: string, mediaIds: string[]) => Promise<void>;
}) {
  const [editing, setEditing] = useState(true);
  return editing ? (
    <PostComposer
      initialBody={post.body}
      initialMedia={post.media}
      submitLabel="Simpan"
      onSubmit={onSubmit}
      onCancel={() => setEditing(false)}
    />
  ) : (
    <button type="button" onClick={() => setEditing(true)}>
      Edit
    </button>
  );
}

describe("PostComposer — Batal discards the whole edit", () => {
  it("Batal discards images added during an edit", async () => {
    mockSuccessfulUploads();
    const onSubmit = mock(async () => {});
    render(<EditHost post={{ body: "isi lama", media: [media("media-1")] }} onSubmit={onSubmit} />);

    choose("baru.jpg");
    await uploadsSettled();
    expect(previewSources().length).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Batal" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    // Only the post's own image is back, and nothing was ever saved.
    expect(previewSources()).toEqual(["/users/media/media-1/thumb"]);
    expect(onSubmit).toHaveBeenCalledTimes(0);
  });

  it("Batal discards a REMOVAL made during an edit too", async () => {
    const onSubmit = mock(async () => {});
    render(
      <EditHost
        post={{ body: "isi lama", media: [media("media-1"), media("media-2")] }}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Hapus foto 1" }));
    expect(previewSources().length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Batal" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(previewSources()).toEqual([
      "/users/media/media-1/thumb",
      "/users/media/media-2/thumb",
    ]);
    expect(onSubmit).toHaveBeenCalledTimes(0);
  });
});

/**
 * An object URL pins its `Blob` in memory until it is revoked or the document
 * goes away. This is a phone-first app: a few megabytes leaked per abandoned
 * composer is a tab the operating system kills in the background, so the
 * revocation is behaviour rather than tidiness — and it is invisible to every
 * other test here, which is why it gets its own.
 */
describe("PostComposer — local previews are freed", () => {
  /** Records what was created and what was revoked, and puts the originals back. */
  async function watchingObjectUrls(
    body: (seen: { created: string[]; revoked: string[] }) => Promise<void>
  ): Promise<{ created: string[]; revoked: string[] }> {
    const seen = { created: [] as string[], revoked: [] as string[] };
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      const url = originalCreate(blob);
      seen.created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      seen.revoked.push(url);
      originalRevoke(url);
    }) as typeof URL.revokeObjectURL;
    try {
      await body(seen);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
    return seen;
  }

  it("frees a removed photo's preview", async () => {
    const seen = await watchingObjectUrls(async () => {
      mockSuccessfulUploads();
      renderComposer();

      choose("satu.jpg");
      await uploadsSettled();
      fireEvent.click(screen.getByRole("button", { name: "Hapus foto 1" }));
    });

    expect(seen.created.length).toBe(1);
    expect(seen.revoked).toEqual(seen.created);
  });

  it("frees every preview once the post is sent", async () => {
    const seen = await watchingObjectUrls(async () => {
      mockSuccessfulUploads();
      renderComposer();

      choose("satu.jpg", "dua.jpg");
      await uploadsSettled();
      type("halo");
      fireEvent.click(submitButton());
      await waitFor(() => {
        expect(textarea().value).toBe("");
      });
    });

    expect(seen.created.length).toBe(2);
    expect(seen.revoked).toEqual(seen.created);
  });

  /**
   * Self-review, and a real bug this caught: the unmount cleanup used to
   * capture `objectUrls.current` at MOUNT time, while `releasePreview`
   * REPLACES that array (`.filter(...)`) rather than mutating it. So every
   * preview created after the first removal lived in an array the cleanup had
   * never seen, and leaked. The sequence below — attach, remove, attach again,
   * leave — is the shortest one that reaches it.
   */
  it("frees a preview created AFTER an earlier one was removed", async () => {
    const seen = await watchingObjectUrls(async () => {
      mockSuccessfulUploads();
      const { unmount } = render(
        <PostComposer submitLabel="Kirim" onSubmit={async () => {}} />
      );

      choose("satu.jpg");
      await uploadsSettled();
      fireEvent.click(screen.getByRole("button", { name: "Hapus foto 1" }));
      choose("dua.jpg");
      await uploadsSettled();
      unmount();
    });

    expect(seen.created.length).toBe(2);
    // Both, and the second one is what regressed.
    expect([...new Set(seen.revoked)].sort()).toEqual([...seen.created].sort());
  });

  it("frees what is left when the composer goes away — Batal, or leaving the page", async () => {
    const seen = await watchingObjectUrls(async () => {
      mockSuccessfulUploads();
      const { unmount } = render(
        <PostComposer submitLabel="Kirim" onSubmit={async () => {}} />
      );

      choose("satu.jpg");
      await uploadsSettled();
      unmount();
    });

    expect(seen.created.length).toBe(1);
    expect(seen.revoked).toEqual(seen.created);
  });
});

/**
 * Fix round 1, Important 1 and 2. Two failures that happen before any request:
 * a photo bigger than the API will accept, and a pick with more photos than
 * there is room for. Both used to be reported through AMBIENT state — the
 * counter and a disabled button — which can say "no more fit" but can never say
 * "I dropped three of the eight you just chose", nor why.
 */
describe("PostComposer — files refused before any request", () => {
  it("refuses a photo over the size limit WITHOUT a request, and says the limit — LITERAL 10 MB", async () => {
    const calls = mockSuccessfulUploads();
    renderComposer();

    chooseFiles(tooBigJpeg("besar.jpg"));
    await settle();

    // Not one byte left the phone: a 10 MB round trip to be told no is the
    // thing this check exists to avoid.
    expect(calls.length).toBe(0);
    expect(previewSources().length).toBe(0);
    expect(notices()).toEqual(["1 foto tidak ditambahkan — ukuran foto maksimal 10 MB."]);
  });

  it("keeps the photos that DO fit when one in the same pick is too big", async () => {
    const calls = mockSuccessfulUploads();
    renderComposer();

    chooseFiles(jpeg("kecil.jpg"), tooBigJpeg("besar.jpg"));
    await uploadsSettled();

    expect(calls.map((call) => call.url)).toEqual(["/users/media"]);
    expect(previewSources().length).toBe(1);
    expect(notices()).toEqual(["1 foto tidak ditambahkan — ukuran foto maksimal 10 MB."]);
  });

  it("says how many photos the LIMIT dropped, not just that the strip is full", async () => {
    await setLimitTo(2);
    mockSuccessfulUploads();
    renderComposer();

    choose("satu.jpg", "dua.jpg", "tiga.jpg", "empat.jpg");
    await uploadsSettled();

    expect(notices()).toEqual(["2 foto tidak ditambahkan — maksimal 2 foto per kiriman."]);
    expect(screen.getByText("2/2 foto")).toBeTruthy();
  });

  it("reports both reasons when one pick hits both", async () => {
    await setLimitTo(1);
    mockSuccessfulUploads();
    renderComposer();

    chooseFiles(jpeg("satu.jpg"), jpeg("dua.jpg"), tooBigJpeg("besar.jpg"));
    await uploadsSettled();

    expect(notices()).toEqual([
      "1 foto tidak ditambahkan — ukuran foto maksimal 10 MB. 1 foto tidak ditambahkan — maksimal 1 foto per kiriman.",
    ]);
  });

  it("says nothing when every chosen photo was taken", async () => {
    mockSuccessfulUploads();
    renderComposer();

    choose("satu.jpg", "dua.jpg");
    await uploadsSettled();

    expect(notices()).toEqual([]);
  });

  /**
   * Mutation-driven (fix round 1). The test below this one removes a photo
   * before picking again, and REMOVAL clears the notice on its own — so a
   * `setNotice` that only ever writes a non-empty sentence survived it. This
   * one leaves the strip untouched between the two picks: the oversized file
   * was never added, so there is nothing to remove and only the pick can clear.
   */
  it("drops a stale notice on the next clean PICK, with nothing removed in between", async () => {
    mockSuccessfulUploads();
    renderComposer();

    chooseFiles(tooBigJpeg("besar.jpg"));
    await settle();
    expect(notices().length).toBe(1);

    choose("kecil.jpg");
    await uploadsSettled();

    expect(notices()).toEqual([]);
    expect(previewSources().length).toBe(1);
  });

  it("drops a stale notice once the next pick is clean", async () => {
    await setLimitTo(2);
    mockSuccessfulUploads();
    renderComposer();

    choose("satu.jpg", "dua.jpg", "tiga.jpg");
    await uploadsSettled();
    expect(notices().length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Hapus foto 1" }));
    choose("empat.jpg");
    await uploadsSettled();

    // The sentence counted photos dropped from a pick that is now history, and
    // there is room again — repeating it would be a lie about this pick.
    expect(notices()).toEqual([]);
  });

  it("drops the notice when a removal makes room, before anything else is picked", async () => {
    await setLimitTo(1);
    mockSuccessfulUploads();
    renderComposer();

    choose("satu.jpg", "dua.jpg");
    await uploadsSettled();
    expect(notices().length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Hapus foto 1" }));

    expect(notices()).toEqual([]);
  });
});

describe("PostComposer — the strip while the post is being sent", () => {
  /**
   * Fix round 1, Minor 4: `busy={submitting}` was unpinned — mutating it to
   * `busy={false}` left the whole suite green. The list of ids in flight must
   * not change under the request that is sending it.
   */
  it("freezes the strip while the send is in flight, and frees it again after", async () => {
    mockSuccessfulUploads();
    let release: (() => void) | null = null;
    const onSubmit = mock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    renderComposer({ onSubmit });

    choose("satu.jpg");
    await uploadsSettled();
    type("halo");
    fireEvent.click(submitButton());

    expect(addButton().disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Hapus foto 1" }) as HTMLButtonElement).disabled
    ).toBe(true);

    await act(async () => {
      release!();
    });

    // Sent: the strip is empty, and adding is possible again.
    await waitFor(() => {
      expect(textarea().value).toBe("");
    });
    expect(addButton().disabled).toBe(false);
  });

  it("freezes a failed image's retry too, so the list cannot change mid-send", async () => {
    let attempt = 0;
    mockFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ id: "media-1", width: 800, height: 600 }, 201)
        : jsonResponse({ error: "internal server error" }, 500);
    });
    let release: (() => void) | null = null;
    const onSubmit = mock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    renderComposer({ onSubmit });

    choose("satu.jpg", "dua.jpg");
    await uploadsSettled();
    type("halo");
    fireEvent.click(submitButton());

    expect(
      (screen.getByRole("button", { name: "Coba lagi unggah foto 2" }) as HTMLButtonElement).disabled
    ).toBe(true);

    await act(async () => {
      release!();
    });
  });
});

/* ------------------------------------------------------------------------ *
 * Task 6 — "Khusus anggota" (spec §7).
 *
 * `visibility = 'members'` requires at least one image, ENFORCED ON THE
 * SERVER (Task 5). The checkbox here is a courtesy that explains the rule
 * before the creator hits it, not the rule itself — so these tests pin the
 * courtesy: disabled-with-a-reason, enabled-once-attached, and un-checked
 * again the moment the last image is gone, so a creator can never submit a
 * members-only post this composer knows has no image.
 * ------------------------------------------------------------------------ */

function membersOnlyBox(): HTMLInputElement {
  return screen.getByLabelText("Khusus anggota") as HTMLInputElement;
}

describe("PostComposer — Khusus anggota (spec §7)", () => {
  it("is unavailable until an image is attached, and says why", () => {
    renderComposer();

    expect(membersOnlyBox().disabled).toBe(true);
    expect(screen.getByTestId("members-only-hint").textContent).toContain(
      "Tambahkan foto dulu"
    );
  });

  it("shows the hint verbatim, in Bahasa Indonesia", () => {
    renderComposer();

    expect(screen.getByTestId("members-only-hint").textContent).toBe(
      "Tambahkan foto dulu — teks selalu bisa dibaca semua orang."
    );
  });

  it("attaching an image enables it", async () => {
    mockSuccessfulUploads();
    renderComposer();

    choose("satu.jpg");
    await uploadsSettled();

    expect(membersOnlyBox().disabled).toBe(false);
    expect(screen.queryAllByTestId("members-only-hint").length).toBe(0);
  });

  it("removing the last image un-checks it rather than leaving an unenforceable lock armed", async () => {
    mockSuccessfulUploads();
    renderComposer();

    choose("satu.jpg");
    await uploadsSettled();
    fireEvent.click(membersOnlyBox());
    expect(membersOnlyBox().checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Hapus foto 1" }));

    expect(membersOnlyBox().checked).toBe(false);
    expect(membersOnlyBox().disabled).toBe(true);
    expect(screen.getByTestId("members-only-hint").textContent).toContain(
      "Tambahkan foto dulu"
    );
  });

  it("leaves it checked, and the box still enabled, when a DIFFERENT image is removed", async () => {
    mockSuccessfulUploads();
    renderComposer();

    choose("satu.jpg", "dua.jpg");
    await uploadsSettled();
    fireEvent.click(membersOnlyBox());

    fireEvent.click(screen.getByRole("button", { name: "Hapus foto 1" }));

    expect(membersOnlyBox().checked).toBe(true);
    expect(membersOnlyBox().disabled).toBe(false);
  });

  it("sends visibility: members when checked, alongside the photo and the caption", async () => {
    mockSuccessfulUploads();
    const onSubmit = mock(async () => {});
    renderComposer({ onSubmit });

    choose("satu.jpg");
    await uploadsSettled();
    fireEvent.click(membersOnlyBox());
    type("hanya untuk anggota");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith("hanya untuk anggota", ["media-1"], "members");
  });

  it("does not send a visibility at all when left unchecked — existing posts stay public by default", async () => {
    mockSuccessfulUploads();
    const onSubmit = mock(async () => {});
    renderComposer({ onSubmit });

    choose("satu.jpg");
    await uploadsSettled();
    type("teks biasa");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith("teks biasa", ["media-1"]);
  });

  it("un-checking after checking it also stops sending members on submit", async () => {
    mockSuccessfulUploads();
    const onSubmit = mock(async () => {});
    renderComposer({ onSubmit });

    choose("satu.jpg");
    await uploadsSettled();
    fireEvent.click(membersOnlyBox());
    fireEvent.click(membersOnlyBox());
    type("berubah pikiran");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith("berubah pikiran", ["media-1"]);
  });

  it("resets to unchecked once the post is sent, along with the box and the strip", async () => {
    mockSuccessfulUploads();
    renderComposer();

    choose("satu.jpg");
    await uploadsSettled();
    fireEvent.click(membersOnlyBox());
    type("halo");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(textarea().value).toBe("");
    });
    expect(membersOnlyBox().checked).toBe(false);
    expect(membersOnlyBox().disabled).toBe(true);
    expect(screen.getByTestId("members-only-hint").textContent).toContain(
      "Tambahkan foto dulu"
    );
  });
});
