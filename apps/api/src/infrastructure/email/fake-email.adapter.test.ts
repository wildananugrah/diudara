import { afterEach, describe, expect, it } from "bun:test";
import { FakeEmailAdapter } from "./fake-email.adapter";

const INPUT = {
  to: "budi@example.com",
  subject: "Pulihkan kata sandi Anda",
  body: "Klik tautan ini untuk memulihkan kata sandi Anda: http://localhost:5173/reset/abc123",
};

describe("FakeEmailAdapter", () => {
  it("records the send instead of making a network call", async () => {
    const adapter = new FakeEmailAdapter();

    await adapter.send(INPUT);

    expect(adapter.sent.length).toBe(1);
    expect(adapter.sent[0]).toEqual(INPUT);
  });

  it("records sends in order across multiple calls", async () => {
    const adapter = new FakeEmailAdapter();

    await adapter.send({ ...INPUT, to: "a@example.com" });
    await adapter.send({ ...INPUT, to: "b@example.com" });

    expect(adapter.sent.map((s) => s.to)).toEqual(["a@example.com", "b@example.com"]);
  });
});

/**
 * The Task 7 gate finding. `sent` above is reachable only by code holding this
 * instance — which, in a running `bun run dev` API, is nobody: `bootstrap()`
 * constructs it and hands it to `RequestPasswordReset`. So a developer running
 * the app locally could request a password reset, watch it succeed, and have NO
 * WAY WHATSOEVER to obtain the link: 33 reset links were minted against the dev
 * database during this gate and the API's stdout stayed at its six startup
 * lines. Local development could not complete a password reset at all.
 *
 * Exactly the gap the PREVIOUS phase's gate found for `FakeAiAdapter` (whose
 * non-default behaviours were reachable only by a test holding the instance) and
 * closed with `AI_FAKE_BEHAVIOUR` — see `resolveAiFakeBehaviour` in bootstrap.ts.
 */
describe("FakeEmailAdapter echo", () => {
  const original = console.log;
  afterEach(() => {
    console.log = original;
  });

  it("prints the recipient, the subject and the WHOLE body when echoing is on", async () => {
    const adapter = new FakeEmailAdapter({ echo: true });
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

    await adapter.send(INPUT);
    console.log = original;

    const printed = lines.join("\n");
    expect(lines.length).toBe(1);
    expect(printed).toContain("[fake-email]");
    expect(printed).toContain("budi@example.com");
    expect(printed).toContain("Pulihkan kata sandi Anda");
    // THE POINT OF THE WHOLE FIX: the reset link must be readable off stdout.
    expect(printed).toContain("http://localhost:5173/reset/abc123");
  });

  it("prints NOTHING by default, so the 100+ tests that construct it stay quiet", async () => {
    const adapter = new FakeEmailAdapter();
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

    await adapter.send(INPUT);
    console.log = original;

    expect(lines.length).toBe(0);
  });

  it("still records the send while echoing, so tests keep working either way", async () => {
    const adapter = new FakeEmailAdapter({ echo: true });
    console.log = () => {};

    await adapter.send(INPUT);
    console.log = original;

    expect(adapter.sent.length).toBe(1);
    expect(adapter.sent[0]).toEqual(INPUT);
  });
});
