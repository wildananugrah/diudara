import { describe, expect, test } from "bun:test";
import { requireMeetingUrl } from "./PostService.ts";

describe("requireMeetingUrl", () => {
  test("accepts real meeting links on an event", () => {
    expect(requireMeetingUrl("event", "https://zoom.us/j/123456789"))
      .toBe("https://zoom.us/j/123456789");
    expect(requireMeetingUrl("event", "https://meet.google.com/abc-defg-hij"))
      .toBe("https://meet.google.com/abc-defg-hij");
    // A pasted bare host still works; https is assumed rather than rejected.
    expect(requireMeetingUrl("event", "  zoom.us/j/999  ")).toBe("https://zoom.us/j/999");
  });

  test("treats an empty link as no link", () => {
    for (const raw of ["", "   ", null, undefined]) {
      expect(requireMeetingUrl("event", raw)).toBeNull();
    }
  });

  test("refuses a scheme that could execute in a member's browser", () => {
    // This URL becomes an href on a page other members open.
    for (const raw of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"]) {
      expect(() => requireMeetingUrl("event", raw)).toThrow(/tidak valid/i);
    }
  });

  test("refuses a meeting link on anything that is not an event", () => {
    for (const type of ["diskusi", "pengumuman", "konten", "anggota"] as const) {
      expect(() => requireMeetingUrl(type, "https://zoom.us/j/1")).toThrow(/hanya untuk kegiatan/i);
    }
    // ...but a blank one is fine, so unrelated posts can pass the field through.
    expect(requireMeetingUrl("diskusi", "")).toBeNull();
  });
});
