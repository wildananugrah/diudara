import { describe, expect, it } from "bun:test";
import { firstLineWithoutParams, redactLinks, safeErrorSummary, safeLabel } from "./log-safety";

describe("redactLinks", () => {
  it("removes an invite link but keeps the sentence around it", () => {
    expect(redactLinks("failed after issuing https://t.me/+SecretToken to the member")).toBe(
      "failed after issuing [link redacted] to the member"
    );
  });

  it("removes a Bot API url, because the bot token is part of its path", () => {
    expect(redactLinks("POST https://api.telegram.org/bot123:ABC/banChatMember returned 400")).not
      .toContain("123:ABC");
  });
});

describe("safeLabel", () => {
  it("cannot forge a second log line", () => {
    expect(safeLabel("evil\n[outbox] all is well")).toBe("evil??outbox??all?is?well");
  });
});

describe("firstLineWithoutParams", () => {
  it("drops drizzle's bound parameters", () => {
    expect(
      firstLineWithoutParams('Failed query: insert into "x" values ($1)\nparams: hunter2')
    ).toBe('Failed query: insert into "x" values ($1)');
  });

  it("still drops them when a driver puts them on the first line", () => {
    expect(firstLineWithoutParams("Failed query: select 1 params: hunter2")).toBe(
      "Failed query: select 1"
    );
  });
});

describe("safeErrorSummary", () => {
  it("passes an ordinary message through unchanged", () => {
    expect(safeErrorSummary(new Error("telegram is down"))).toBe("telegram is down");
  });

  it("reports a wrapped driver failure's REASON, which lives on the cause", () => {
    // The exact shape drizzle-orm produces: the message is the statement plus its
    // bound values, and the constraint violation is one link down.
    const driverError = new Error(
      'insert or update on table "activity_log" violates foreign key constraint ' +
        '"activity_log_member_id_member_id_fk"'
    );
    const wrapped = new Error(
      'Failed query: insert into "activity_log" ("id", "member_id") values (default, $1)\n' +
        "params: 0812-payer-pii",
      { cause: driverError }
    );

    const summary = safeErrorSummary(wrapped);

    expect(summary).toContain("violates foreign key constraint");
    expect(summary).not.toContain("params:");
    expect(summary).not.toContain("0812-payer-pii");
    // One line: a multi-line reason forges a second log line.
    expect(summary).not.toContain("\n");
  });

  it("does not let a long outer message crowd out the cause", () => {
    const cause = new Error("duplicate key value violates unique constraint");
    const summary = safeErrorSummary(new Error("Failed query: ".padEnd(2000, "x"), { cause }));

    // The whole point of the per-part budget: an operator reading
    // `outbox.last_error` must still find the reason.
    expect(summary).toContain("duplicate key value violates unique constraint");
  });

  it("says nothing twice when a wrapper only restates its cause", () => {
    const cause = new Error("nope");
    expect(safeErrorSummary(new Error("nope", { cause }))).toBe("nope");
  });

  it("terminates on a cause cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    expect(safeErrorSummary(b)).toBe("b: a");
  });

  it("never stringifies a thrown non-Error, which would print its contents", () => {
    expect(safeErrorSummary({ password: "hunter2" })).toBe("non-Error thrown: object");
  });

  it("names an Error that carries no message at all", () => {
    expect(safeErrorSummary(new TypeError(""))).toBe("TypeError with no message");
  });
});
