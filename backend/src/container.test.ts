import { describe, expect, test } from "bun:test";
import { createContainer } from "./container.ts";

/**
 * The test that exists because of one design choice.
 *
 * Notifications are delivered through an event bus, so the services that emit do
 * not hold a reference to the thing that listens. That decoupling is the point —
 * and it means deleting one `subscribe` line in container.ts compiles, passes
 * every other test, starts cleanly, and silently stops every notification in the
 * product. Nothing else would notice.
 *
 * With direct calls this test would be unnecessary (a missing collaborator is a
 * compile error). It is the price of the bus, and it is cheap.
 */
describe("container wiring", () => {
  test("something is subscribed to the event bus", () => {
    const container = createContainer();
    expect(container.events.subscriberCount).toBeGreaterThan(0);
  });

  test("an emitted event reaches a subscriber", async () => {
    // Proves the wiring delivers, not merely that a handler is registered.
    const container = createContainer();
    let delivered = false;
    container.events.subscribe(async () => { delivered = true; });

    await container.events.emit({
      type: "membership.ended", userId: "nobody", communityId: "nowhere",
    });

    expect(delivered).toBe(true);
  });
});
