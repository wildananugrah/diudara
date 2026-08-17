import { describe, expect, it } from "bun:test";
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
