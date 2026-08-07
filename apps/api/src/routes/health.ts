import { Hono } from "hono";
import type { Dependencies } from "../bootstrap";

export function healthRoute(deps: Dependencies) {
  return new Hono().get("/", async (c) => {
    await deps.sql`select 1`;
    return c.json({ status: "ok" });
  });
}
