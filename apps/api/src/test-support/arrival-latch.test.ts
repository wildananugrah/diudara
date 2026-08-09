import { describe, expect, it } from "bun:test";
import { ArrivalLatch } from "./arrival-latch";

/**
 * The instrument the concurrency tests depend on, pinned first.
 *
 * Phase 4's lesson was that a barrier which releases on TIME lets the test it serves
 * pass without the race ever happening — so the barrier itself needs tests, or the
 * green result downstream means nothing.
 */
describe("ArrivalLatch", () => {
  it("does NOT release on time alone — only the missing arrivals release it", async () => {
    const latch = new ArrivalLatch(2, 120);
    latch.arrive();

    // A temporal barrier would resolve here once its timeout elapsed. This must
    // reject: nothing has contended yet, so releasing would let the test that
    // depends on it pass without the interleaving.
    await expect(latch.wait()).rejects.toThrow(/only 1 of 2 callers arrived/);
  });

  it("releases as soon as the expected callers arrive, however long that took", async () => {
    const latch = new ArrivalLatch(2, 5_000);
    latch.arrive();
    const waiting = latch.wait();
    // Well past any fixed timeout a temporal barrier would have used.
    setTimeout(() => latch.arrive(), 300);

    await waiting;
  });

  it("holds every caller until all of them have arrived", async () => {
    const latch = new ArrivalLatch(2);
    const events: string[] = [];

    const caller = async (name: string) => {
      events.push(`${name}-arrived`);
      await latch.arriveAndWait();
      events.push(`${name}-proceeded`);
    };

    await Promise.all([caller("a"), caller("b")]);

    // THE property: no caller proceeds before both have arrived. Without it the two
    // passes under test could run one after the other and never contend.
    expect(events.slice(0, 2).sort()).toEqual(["a-arrived", "b-arrived"]);
    expect(events.slice(2).sort()).toEqual(["a-proceeded", "b-proceeded"]);
  });

  it("resolves immediately for a caller that arrives after the count is reached", async () => {
    const latch = new ArrivalLatch(1);
    latch.arrive();
    expect(latch.arrived).toBe(1);
    await latch.wait();
  });
});
