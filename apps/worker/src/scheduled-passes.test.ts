import { describe, expect, it } from "bun:test";
import {
  createScheduledPassLoops,
  DEFAULT_RENEWAL_INTERVAL_MS,
  formatChurnPassLine,
  formatPassFailure,
  formatRenewalPassLine,
  resolveRenewalIntervalMs,
} from "./scheduled-passes";

/**
 * Like `poll-loop.test.ts`, these tests import only worker modules and the API's
 * dependency-free `log-safety` helper. `bun run --workspaces test` runs this from
 * `apps/worker`, where `apps/api/.env` is not loaded, so anything reaching
 * `db/client.ts` would fail on a missing DATABASE_URL instead of testing anything.
 */

const NOTHING_HAPPENED_RENEWAL = {
  considered: 0,
  reminded: 0,
  alreadyReminded: 0,
  skipped: 0,
  transitionedToPastDue: 0,
};

const NOTHING_HAPPENED_CHURN = {
  considered: 0,
  churned: 0,
  alreadyChurned: 0,
  revocationsQueued: 0,
  skippedRevocation: 0,
};

/** Counts, an optional stage-free label, `=` and spaces. Nothing else may appear. */
const COUNTS_ONLY = /^\[(renewals|churn)\] (?:[a-z_]+=\d+ ?)+$/;

describe("formatRenewalPassLine", () => {
  it("says nothing when the pass had nothing to do", () => {
    // A daily-ish pass over an empty window is the normal case, and one
    // "considered 0" line per tick would bury the lines that matter.
    expect(formatRenewalPassLine(NOTHING_HAPPENED_RENEWAL)).toBeNull();
  });

  it("reports every count when the pass did something", () => {
    const line = formatRenewalPassLine({
      considered: 4,
      reminded: 2,
      alreadyReminded: 1,
      skipped: 1,
      transitionedToPastDue: 2,
    });

    expect(line).toBe(
      "[renewals] considered=4 reminded=2 already_reminded=1 skipped=1 past_due=2"
    );
  });

  it("speaks up when a pass considered rows and reminded nobody", () => {
    // `considered>0, reminded=0` is the shape of a pass that is finding rows and
    // failing to act on them, so it must not be silent.
    expect(formatRenewalPassLine({ ...NOTHING_HAPPENED_RENEWAL, considered: 3 })).toContain(
      "considered=3"
    );
  });

  it("emits counts and nothing else — no member, no link, no phone number", () => {
    const line = formatRenewalPassLine({
      considered: 1,
      reminded: 1,
      alreadyReminded: 0,
      skipped: 0,
      transitionedToPastDue: 1,
    });

    expect(line).toMatch(COUNTS_ONLY);
  });
});

describe("formatChurnPassLine", () => {
  it("says nothing when the pass had nothing to do", () => {
    expect(formatChurnPassLine(NOTHING_HAPPENED_CHURN)).toBeNull();
  });

  it("reports every count when the pass did something", () => {
    const line = formatChurnPassLine({
      considered: 3,
      churned: 2,
      alreadyChurned: 1,
      revocationsQueued: 2,
      skippedRevocation: 0,
    });

    expect(line).toBe(
      "[churn] considered=3 churned=2 already_churned=1 revocations_queued=2 skipped_revocation=0"
    );
  });

  it("emits counts and nothing else", () => {
    expect(formatChurnPassLine({ ...NOTHING_HAPPENED_CHURN, considered: 2, churned: 1 })).toMatch(
      COUNTS_ONLY
    );
  });
});

describe("formatPassFailure", () => {
  it("drops the bound parameters of a failed query", () => {
    // Exactly what Phase 4 found in the worker's log: drizzle formats a query
    // failure as the statement plus its bound values, and the values are the
    // member's phone number.
    const drizzle = new Error(
      'Failed query: insert into "renewal_reminder" ("subscription_id") values ($1)\n' +
        "params: +6281234567890,Siti"
    );
    drizzle.cause = new Error('duplicate key value violates unique constraint "renewal_reminder_subscription_id_stage_unique"');

    const line = formatPassFailure("renewals", drizzle);

    expect(line).not.toContain("+6281234567890");
    expect(line).not.toContain("params:");
    // …and it still says what actually went wrong, which is the reason the cause
    // chain is walked rather than the outer message truncated.
    expect(line).toContain("duplicate key");
    expect(line.startsWith("[renewals] pass failed: ")).toBe(true);
  });

  it("redacts anything URL-shaped, because an invite link is a bearer credential", () => {
    const line = formatPassFailure("churn", new Error("telegram said no for https://t.me/+aBcSecret"));

    expect(line).not.toContain("t.me");
    expect(line).toContain("[link redacted]");
  });

  it("is always one line, so a thrown message cannot forge a second one", () => {
    const line = formatPassFailure("renewals", new Error("boom\n[worker] all is well"));

    expect(line.split("\n")).toHaveLength(1);
  });

  it("survives a non-Error being thrown without printing its contents", () => {
    const line = formatPassFailure("churn", { whatsappNumber: "+6281234567890" });

    expect(line).not.toContain("6281234567890");
    expect(line).toContain("non-Error");
  });
});

describe("resolveRenewalIntervalMs", () => {
  it("defaults when the variable is unset or blank", () => {
    expect(resolveRenewalIntervalMs(undefined)).toBe(DEFAULT_RENEWAL_INTERVAL_MS);
    expect(resolveRenewalIntervalMs("")).toBe(DEFAULT_RENEWAL_INTERVAL_MS);
    expect(resolveRenewalIntervalMs("   ")).toBe(DEFAULT_RENEWAL_INTERVAL_MS);
  });

  it("defaults to an interval MUCH longer than the outbox pass", () => {
    // The outbox pass is 5s because it is the delay a paying member sees on their
    // invite. These passes decide whole WIB calendar days, so a 5s cadence would
    // be tens of thousands of pointless queries a day.
    expect(DEFAULT_RENEWAL_INTERVAL_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("uses a configured value", () => {
    expect(resolveRenewalIntervalMs("60000")).toBe(60_000);
  });

  it("refuses a value that is not a usable interval, naming its own variable", () => {
    for (const bad of ["abc", "0", "-1", "1.5", "1e9999"]) {
      expect(() => resolveRenewalIntervalMs(bad)).toThrow(/WORKER_RENEWAL_INTERVAL_MS/);
    }
  });
});

/** A pass that counts its calls and can be told to throw. */
function fakePass<T>(result: T) {
  const state = { calls: 0, throwOnCall: 0 };
  return {
    state,
    execute: async (): Promise<T> => {
      state.calls += 1;
      if (state.calls === state.throwOnCall) throw new Error("database was briefly unreachable");
      return result;
    },
  };
}

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("createScheduledPassLoops", () => {
  it("runs one pass of each type immediately, then waits out the interval", async () => {
    const processRenewals = fakePass({ ...NOTHING_HAPPENED_RENEWAL, reminded: 1 });
    const processChurn = fakePass({ ...NOTHING_HAPPENED_CHURN, churned: 1 });
    const lines: string[] = [];
    const { renewalLoop, churnLoop } = createScheduledPassLoops({
      processRenewals,
      processChurn,
      intervalMs: 60_000,
      log: (line) => lines.push(line),
    });

    const running = Promise.all([renewalLoop.run(), churnLoop.run()]);
    await waitUntil(
      () => processRenewals.state.calls > 0 && processChurn.state.calls > 0,
      "the first pass of each type"
    );
    // Long enough that a 5s-ish interval — or no interval at all — would show up
    // as a second pass.
    await Bun.sleep(25);
    expect(processRenewals.state.calls).toBe(1);
    expect(processChurn.state.calls).toBe(1);

    renewalLoop.stop();
    churnLoop.stop();
    const finished = await Promise.race([
      running.then(() => "stopped"),
      Bun.sleep(2_000).then(() => "still sleeping in the interval"),
    ]);

    expect(finished).toBe("stopped");
    expect(lines).toEqual([
      "[renewals] considered=0 reminded=1 already_reminded=0 skipped=0 past_due=0",
      "[churn] considered=0 churned=1 already_churned=0 revocations_queued=0 skipped_revocation=0",
    ]);
  });

  it("keeps running after a pass throws, and keeps the OTHER pass running too", async () => {
    // The rows are still in the database and the next pass is their retry. An
    // unhandled rejection here would take the whole worker down — including the
    // outbox loop that delivers what payments already bought.
    const processRenewals = fakePass(NOTHING_HAPPENED_RENEWAL);
    processRenewals.state.throwOnCall = 1;
    const processChurn = fakePass(NOTHING_HAPPENED_CHURN);
    const errors: string[] = [];
    const { renewalLoop, churnLoop } = createScheduledPassLoops({
      processRenewals,
      processChurn,
      intervalMs: 1,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });

    const running = Promise.all([renewalLoop.run(), churnLoop.run()]);
    await waitUntil(
      () => processRenewals.state.calls >= 3 && processChurn.state.calls >= 3,
      "both passes to keep going after the throw"
    );
    renewalLoop.stop();
    churnLoop.stop();
    await running;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[renewals] pass failed: database was briefly unreachable");
  });

  it("never overlaps two passes of the same type", async () => {
    // The passes page through the whole backlog, so a slow one must not have a
    // second copy of itself claiming the same rows. `PollLoop` guarantees this;
    // the assertion is that these loops are built on it rather than on a timer.
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const slowRenewals = {
      execute: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(5);
        inFlight -= 1;
        calls += 1;
        return NOTHING_HAPPENED_RENEWAL;
      },
    };
    const { renewalLoop, churnLoop } = createScheduledPassLoops({
      processRenewals: slowRenewals,
      processChurn: fakePass(NOTHING_HAPPENED_CHURN),
      intervalMs: 1,
      log: () => undefined,
    });

    const running = Promise.all([renewalLoop.run(), churnLoop.run()]);
    await waitUntil(() => calls >= 3, "three renewal passes");
    renewalLoop.stop();
    churnLoop.stop();
    await running;

    expect(maxInFlight).toBe(1);
  });
});
