import { describe, expect, test } from "bun:test";
import { safeHttpUrl } from "./links.ts";

describe("safeHttpUrl", () => {
  test("accepts ordinary http(s) links", () => {
    expect(safeHttpUrl("https://example.com/modul.pdf")).toBe("https://example.com/modul.pdf");
    expect(safeHttpUrl("http://example.com/a.mp3")).toBe("http://example.com/a.mp3");
    expect(safeHttpUrl("https://drive.google.com/file/d/abc/view?usp=sharing"))
      .toBe("https://drive.google.com/file/d/abc/view?usp=sharing");
  });

  test("assumes https when the scheme is missing, and trims", () => {
    expect(safeHttpUrl("  example.com/modul.pdf  ")).toBe("https://example.com/modul.pdf");
  });

  test("rejects schemes that execute or embed data", () => {
    // The whole point of this function: a pasted link must not become script.
    const dangerous = [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "ftp://example.com/a.mp3",
    ];
    for (const url of dangerous) expect(safeHttpUrl(url)).toBeNull();
  });

  test("rejects empty, malformed, and hostless input", () => {
    for (const url of ["", "   ", null, undefined, "not a url", "https:///nohost", "https://localhost"]) {
      expect(safeHttpUrl(url)).toBeNull();
    }
  });
});
