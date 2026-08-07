import { describe, expect, it } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";

describe("GET /health", () => {
  it("returns 200 with status ok when the database is reachable", async () => {
    const app = createApp(bootstrap());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("returns 500 when the database is unreachable", async () => {
    const app = createApp({ ...bootstrap(), sql: (() => Promise.reject(new Error("down"))) as never });
    expect((await app.request("/health")).status).toBe(500);
  });
});
