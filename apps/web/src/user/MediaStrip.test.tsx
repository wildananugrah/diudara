import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import MediaStrip, { type MediaStripItem, type MediaStripProps } from "./MediaStrip";

afterEach(() => cleanup());

/**
 * **No DOM node ever reaches an assertion in this file.** A failing matcher
 * serialises what it received, and a happy-dom element drags its listener maps,
 * its parent chain and every internal symbol along with it — measured in this
 * repo on bun 1.3.14 at 848 KB for a bare detached `<div>` and at "does not
 * terminate" for a node attached to a rendered document. Everything below
 * asserts on STRINGS, on COUNTS and on booleans, exactly as
 * `BerandaPage.test.tsx`'s `isNode` helper does for identity.
 */
function item(overrides: Partial<MediaStripItem> = {}): MediaStripItem {
  return {
    key: "k1",
    status: "ready",
    previewUrl: "/users/media/media-1/thumb",
    error: null,
    ...overrides,
  };
}

function renderStrip(props: Partial<MediaStripProps> = {}) {
  const onAdd = props.onAdd ?? mock(() => {});
  const onRemove = props.onRemove ?? mock(() => {});
  const onRetry = props.onRetry ?? mock(() => {});
  render(
    <MediaStrip
      items={props.items ?? []}
      max={props.max ?? 5}
      busy={props.busy ?? false}
      onAdd={onAdd}
      onRemove={onRemove}
      onRetry={onRetry}
    />
  );
  return { onAdd, onRemove, onRetry };
}

function picker(): HTMLInputElement {
  return screen.getByTestId("media-picker") as HTMLInputElement;
}

function addButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Tambah foto" }) as HTMLButtonElement;
}

function jpeg(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
}

describe("MediaStrip — what it shows", () => {
  it("shows one preview per image, in the order given", () => {
    renderStrip({
      items: [
        item({ key: "k1", previewUrl: "/users/media/media-1/thumb" }),
        item({ key: "k2", previewUrl: "blob:local-2" }),
      ],
    });

    // Strings, never the elements themselves.
    expect(screen.getAllByRole("img").map((img) => img.getAttribute("src"))).toEqual([
      "/users/media/media-1/thumb",
      "blob:local-2",
    ]);
  });

  it("gives every preview Bahasa alt text naming its position", () => {
    renderStrip({ items: [item({ key: "k1" }), item({ key: "k2" })] });

    expect(screen.getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual([
      "Pratinjau foto 1",
      "Pratinjau foto 2",
    ]);
  });

  it("counts the attached images against the limit — LITERAL 5", () => {
    renderStrip({ items: [item({ key: "k1" }), item({ key: "k2" })], max: 5 });

    expect(screen.getByText("2/5 foto")).toBeTruthy();
  });

  it("counts nothing as 0 rather than hiding the counter", () => {
    renderStrip({ items: [], max: 5 });

    expect(screen.getByText("0/5 foto")).toBeTruthy();
  });

  it("shows an image with no preview at all without crashing", () => {
    // A seeded item whose thumbnail is still unknown must not render `src=""`,
    // which a browser resolves against the page URL and refetches the document.
    renderStrip({ items: [item({ previewUrl: null })] });

    expect(screen.queryAllByRole("img").length).toBe(0);
    expect(screen.getByText("1/5 foto")).toBeTruthy();
  });
});

describe("MediaStrip — per-image progress and per-image failure", () => {
  it("marks the uploading image as in progress, and only that one", () => {
    renderStrip({
      items: [item({ key: "k1", status: "ready" }), item({ key: "k2", status: "uploading" })],
    });

    expect(screen.getAllByRole("progressbar").length).toBe(1);
    expect(screen.getByRole("progressbar", { name: "Mengunggah foto 2" }).textContent).toBe(
      "Mengunggah…"
    );
  });

  it("shows the failed image's own Bahasa sentence, and only against that image", () => {
    renderStrip({
      items: [
        item({ key: "k1", status: "ready" }),
        item({
          key: "k2",
          status: "failed",
          error: "Foto gagal diunggah. Server sedang bermasalah. Coba lagi sebentar lagi.",
        }),
      ],
    });

    expect(screen.getAllByRole("alert").length).toBe(1);
    expect(screen.getByRole("alert").textContent).toBe(
      "Foto gagal diunggah. Server sedang bermasalah. Coba lagi sebentar lagi."
    );
  });

  it("offers a retry on the failed image ONLY, and retries that exact one", () => {
    const retried: string[] = [];
    renderStrip({
      items: [
        item({ key: "k1", status: "ready" }),
        item({ key: "k2", status: "failed", error: "Foto gagal diunggah." }),
        item({ key: "k3", status: "uploading" }),
      ],
      onRetry: (key: string) => retried.push(key),
    });

    expect(screen.getAllByRole("button", { name: /Coba lagi/ }).length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Coba lagi unggah foto 2" }));

    // The KEY, a string — never the item object or the button element.
    expect(retried).toEqual(["k2"]);
  });
});

describe("MediaStrip — removing", () => {
  it("removes the image whose button was pressed, by key", () => {
    const removed: string[] = [];
    renderStrip({
      items: [item({ key: "k1" }), item({ key: "k2" }), item({ key: "k3" })],
      onRemove: (key: string) => removed.push(key),
    });

    fireEvent.click(screen.getByRole("button", { name: "Hapus foto 2" }));

    expect(removed).toEqual(["k2"]);
  });

  it("offers removal for an uploading and a failed image too — nothing is stuck", () => {
    renderStrip({
      items: [
        item({ key: "k1", status: "uploading" }),
        item({ key: "k2", status: "failed", error: "Foto gagal diunggah." }),
      ],
    });

    expect(screen.getAllByRole("button", { name: /^Hapus foto/ }).length).toBe(2);
  });
});

describe("MediaStrip — adding", () => {
  it("opens the file picker when Tambah foto is pressed", () => {
    const original = HTMLInputElement.prototype.click;
    let clicked = 0;
    HTMLInputElement.prototype.click = function () {
      clicked += 1;
    };
    try {
      renderStrip();
      fireEvent.click(addButton());
    } finally {
      HTMLInputElement.prototype.click = original;
    }

    expect(clicked).toBe(1);
  });

  it("hands every chosen file to onAdd, in the order chosen", () => {
    const added: string[][] = [];
    renderStrip({ onAdd: (files: File[]) => added.push(files.map((file) => file.name)) });

    fireEvent.change(picker(), { target: { files: [jpeg("satu.jpg"), jpeg("dua.jpg")] } });

    expect(added).toEqual([["satu.jpg", "dua.jpg"]]);
  });

  it("clears the picker afterwards, so the SAME file can be chosen twice", () => {
    // Without this, `change` never fires for a repeat choice — the input's
    // value has not changed — and the second attempt silently does nothing.
    renderStrip();

    fireEvent.change(picker(), { target: { files: [jpeg("satu.jpg")] } });

    expect(picker().value).toBe("");
  });

  it("accepts images only, and more than one at a time", () => {
    renderStrip();

    expect(picker().getAttribute("accept")).toBe("image/*");
    expect(picker().hasAttribute("multiple")).toBe(true);
  });

  it("disables Tambah foto at the limit — LITERAL 2", () => {
    renderStrip({ items: [item({ key: "k1" }), item({ key: "k2" })], max: 2 });

    expect(addButton().disabled).toBe(true);
    expect(screen.getByText("2/2 foto")).toBeTruthy();
  });

  it("leaves Tambah foto enabled one below the limit", () => {
    renderStrip({ items: [item({ key: "k1" })], max: 2 });

    expect(addButton().disabled).toBe(false);
  });

  /**
   * An image still uploading counts against the limit exactly as a finished one
   * does. It occupies a slot the person can see, and the id it will produce is
   * going onto the post — counting only the finished ones would let five
   * uploads in flight become a sixth attachment the server then refuses.
   */
  it("counts an uploading and a failed image against the limit too", () => {
    renderStrip({
      items: [item({ key: "k1", status: "uploading" }), item({ key: "k2", status: "failed" })],
      max: 2,
    });

    expect(addButton().disabled).toBe(true);
  });
});

describe("MediaStrip — while the post itself is being sent", () => {
  it("disables adding, removing and retrying, so the sent list cannot change mid-flight", () => {
    renderStrip({
      items: [item({ key: "k1" }), item({ key: "k2", status: "failed", error: "gagal" })],
      busy: true,
    });

    expect(addButton().disabled).toBe(true);
    expect(
      screen
        .getAllByRole("button", { name: /^Hapus foto/ })
        .every((button) => (button as HTMLButtonElement).disabled)
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Coba lagi unggah foto 2" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});
