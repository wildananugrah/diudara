import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PostComposer from "./PostComposer";
import { UserApiError } from "./apiClient";

afterEach(() => cleanup());

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
  render(<PostComposer submitLabel="Kirim" {...props} onSubmit={onSubmit} />);
  return { onSubmit };
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
    expect(onSubmit).toHaveBeenCalledWith("halo dunia");
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
