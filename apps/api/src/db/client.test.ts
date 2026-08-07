import { describe, expect, it } from "bun:test";
import { sql } from "./client";

describe("postgres connection", () => {
  it("connects and executes a basic query", async () => {
    const rows = await sql`select 1 as one`;
    expect(rows[0].one).toBe(1);
  });
});
