import { describe, expect, it } from "bun:test";
import { formatRelativeTime } from "./relativeTime";

const NOW = new Date("2026-08-18T12:00:00.000Z");

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it('reads "baru saja" under a minute', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe("baru saja");
    expect(formatRelativeTime(ago(59 * SECOND), NOW)).toBe("baru saja");
  });

  it("switches to minutes at exactly one minute", () => {
    expect(formatRelativeTime(ago(MINUTE), NOW)).toBe("1m");
    expect(formatRelativeTime(ago(59 * MINUTE), NOW)).toBe("59m");
  });

  it("switches to hours at exactly one hour", () => {
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe("1j");
    expect(formatRelativeTime(ago(23 * HOUR), NOW)).toBe("23j");
  });

  it("switches to days at exactly one day", () => {
    expect(formatRelativeTime(ago(DAY), NOW)).toBe("1h");
    expect(formatRelativeTime(ago(6 * DAY), NOW)).toBe("6h");
  });

  it("switches to an absolute Indonesian date at seven days", () => {
    expect(formatRelativeTime(ago(7 * DAY), NOW)).toBe("11 Agu 2026");
  });

  it('treats a future timestamp as "baru saja" rather than negative', () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + HOUR).toISOString(), NOW)).toBe("baru saja");
  });

  it("returns an empty string for an unparseable value rather than NaN", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBe("");
  });
});
