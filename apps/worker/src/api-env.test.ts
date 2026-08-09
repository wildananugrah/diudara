import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultApiEnvPath, loadApiEnv, parseDotEnv } from "./api-env";

function writeEnvFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "diudara-worker-env-")), ".env");
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("parseDotEnv", () => {
  it("reads assignments and skips comments, blanks and junk", () => {
    expect(
      parseDotEnv(
        [
          "# a comment",
          "",
          "DATABASE_URL=postgres://user:pass@localhost:5432/db",
          "   ",
          "NOT_AN_ASSIGNMENT",
          "NODE_ENV=development",
        ].join("\n")
      )
    ).toEqual({
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      NODE_ENV: "development",
    });
  });

  it("keeps everything after the FIRST equals sign", () => {
    // Real values contain '=': base64 JWT secrets end in padding, and connection
    // strings carry query parameters.
    expect(parseDotEnv("JWT_SECRET=abc==\nURL=postgres://h/db?sslmode=require")).toEqual({
      JWT_SECRET: "abc==",
      URL: "postgres://h/db?sslmode=require",
    });
  });

  it("strips one layer of surrounding quotes", () => {
    expect(parseDotEnv('TOKEN="quoted"')).toEqual({ TOKEN: "quoted" });
  });
});

describe("loadApiEnv", () => {
  it("fills values from apps/api/.env", () => {
    const env: Record<string, string | undefined> = {};
    const envFilePath = writeEnvFile("DATABASE_URL=postgres://from-file/db\nNODE_ENV=development");

    loadApiEnv({ envFilePath, env });

    expect(env.DATABASE_URL).toBe("postgres://from-file/db");
    expect(env.NODE_ENV).toBe("development");
  });

  it("never overrides a real environment variable", () => {
    // A container injecting its own configuration must win over a file that
    // happens to be in the image.
    const env: Record<string, string | undefined> = { DATABASE_URL: "postgres://from-env/db" };
    const envFilePath = writeEnvFile("DATABASE_URL=postgres://from-file/db");

    loadApiEnv({ envFilePath, env });

    expect(env.DATABASE_URL).toBe("postgres://from-env/db");
  });

  it("accepts a missing file when the environment already has what it needs", () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: "postgres://from-env/db" };
    expect(() =>
      loadApiEnv({ envFilePath: "/nonexistent/apps/api/.env", env })
    ).not.toThrow();
  });

  it("throws one actionable line when nothing supplies DATABASE_URL", () => {
    // Without this the process died inside db/client.ts at import time, before
    // any of the worker's own code ran.
    expect(() => loadApiEnv({ envFilePath: "/nonexistent/apps/api/.env", env: {} })).toThrow(
      /DATABASE_URL is not set/
    );
  });

  it("defaults to apps/api/.env, not to the worker's own directory", () => {
    // The worker has no .env of its own on purpose: it reads the same database
    // and the same messaging tokens as the API.
    expect(defaultApiEnvPath().endsWith("/apps/api/.env")).toBe(true);
  });
});
