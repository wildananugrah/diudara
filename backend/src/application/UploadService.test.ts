import { describe, expect, test } from "bun:test";
import { libraryTypeOf } from "./UploadService.ts";

describe("libraryTypeOf", () => {
  test("anything playable is a video, whatever its mime", () => {
    // kind wins here: the library icon should match how it will be consumed.
    expect(libraryTypeOf("video/mp4", "video")).toBe("video");
    expect(libraryTypeOf("application/octet-stream", "video")).toBe("video");
  });

  test("readable formats are documents", () => {
    for (const mime of [
      "application/pdf",
      "application/epub+zip",
      "text/plain",
      "text/markdown",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.oasis.opendocument.text",
    ]) {
      expect(libraryTypeOf(mime, "file")).toBe("document");
    }
  });

  test("everything else falls back to file", () => {
    // The Dokumen tab has no icon beyond these three, so an unknown mime must
    // land on "file" rather than leaking a raw mime into the UI.
    for (const mime of ["application/zip", "application/octet-stream", "application/x-tar", ""]) {
      expect(libraryTypeOf(mime, "file")).toBe("file");
    }
  });

  test("only ever returns the three types the library renders", () => {
    const allowed = new Set(["document", "video", "file"]);
    const samples: Array<[string, "image" | "video" | "audio" | "file"]> = [
      ["image/png", "image"], ["audio/mpeg", "audio"], ["video/webm", "video"],
      ["application/pdf", "file"], ["weird/thing", "file"],
    ];
    for (const [mime, kind] of samples) {
      expect(allowed.has(libraryTypeOf(mime, kind))).toBe(true);
    }
  });
});
