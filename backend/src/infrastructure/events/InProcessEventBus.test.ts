import { describe, expect, test } from "bun:test";
import { InProcessEventBus } from "./InProcessEventBus.ts";
import type { DomainEvent } from "../../domain/events.ts";

const anEvent: DomainEvent = {
  type: "membership.ended", userId: "u1", communityId: "bimbel-sbmptn",
};

describe("InProcessEventBus", () => {
  test("hands the event to every subscriber", async () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    bus.subscribe(async (e) => { seen.push(`a:${e.type}`); });
    bus.subscribe(async (e) => { seen.push(`b:${e.type}`); });

    await bus.emit(anEvent);

    expect(seen).toEqual(["a:membership.ended", "b:membership.ended"]);
  });

  test("a throwing subscriber neither rejects the emit nor stops the others", async () => {
    // THE point of the bus's error policy: a notification that fails to save must
    // never make the comment, payment or message that caused it look broken.
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    bus.subscribe(async () => { throw new Error("database is on fire"); });
    bus.subscribe(async (e) => { seen.push(e.type); });

    await expect(bus.emit(anEvent)).resolves.toBeUndefined();
    expect(seen).toEqual(["membership.ended"]);
  });

  test("emitting with nobody listening is not an error", async () => {
    const bus = new InProcessEventBus();
    await expect(bus.emit(anEvent)).resolves.toBeUndefined();
  });

  test("reports how many subscribers it has", async () => {
    // Exists for the container test: with a bus, forgetting to subscribe compiles
    // and runs and silently produces nothing, so the wiring needs an assertion.
    const bus = new InProcessEventBus();
    expect(bus.subscriberCount).toBe(0);
    bus.subscribe(async () => {});
    expect(bus.subscriberCount).toBe(1);
  });
});
