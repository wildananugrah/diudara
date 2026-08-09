import { describe, expect, it } from "bun:test";
import {
  PER_RUN_DATABASE_PREFIX,
  createdAtOfPerRunDatabase,
  isolationIsEnabled,
  perRunDatabaseName,
  withDatabaseName,
} from "./test-database";

describe("perRunDatabaseName", () => {
  it("is prefixed, timestamped and unique per process", () => {
    const first = perRunDatabaseName();
    const second = perRunDatabaseName();

    expect(first.startsWith(PER_RUN_DATABASE_PREFIX)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("fits inside Postgres's 63-byte identifier limit", () => {
    // A longer name is silently TRUNCATED by Postgres, and two runs whose names
    // differ only past byte 63 would then share a database — the exact failure this
    // whole mechanism exists to remove, reintroduced invisibly.
    expect(perRunDatabaseName().length).toBeLessThanOrEqual(63);
  });

  it("is a bare lower-case identifier, so it never needs quoting", () => {
    // The name is interpolated into `create database` — which cannot take a bound
    // parameter — so it must be incapable of carrying anything but a name.
    expect(perRunDatabaseName()).toMatch(/^[a-z0-9_]+$/);
  });

  it("carries its creation time, so a later run can collect what a crashed one left", () => {
    const before = Date.now();
    const created = createdAtOfPerRunDatabase(perRunDatabaseName());

    expect(created).not.toBeNull();
    expect(created!).toBeGreaterThanOrEqual(before - 1_000);
    expect(created!).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});

describe("createdAtOfPerRunDatabase", () => {
  it("refuses any name that is not one of ours", () => {
    // This is what stands between the garbage collector and a real database. It is
    // asked about every database on the server, and `diudara` is one of them.
    for (const notOurs of [
      "diudara",
      "postgres",
      "template1",
      "diudara_production",
      "diudara_test",
      `${PER_RUN_DATABASE_PREFIX}nonsense`,
      `${PER_RUN_DATABASE_PREFIX}12ab_1_x`,
    ]) {
      expect(createdAtOfPerRunDatabase(notOurs)).toBeNull();
    }
  });
});

describe("withDatabaseName", () => {
  it("swaps the database and keeps the credentials, host and port", () => {
    expect(
      withDatabaseName("postgres://diudara:s3cret@localhost:5432/diudara", "diudara_test_1_2_3")
    ).toBe("postgres://diudara:s3cret@localhost:5432/diudara_test_1_2_3");
  });

  it("keeps query parameters, which carry sslmode on a managed database", () => {
    expect(
      withDatabaseName("postgres://u:p@db.example:5432/app?sslmode=require", "t")
    ).toBe("postgres://u:p@db.example:5432/t?sslmode=require");
  });

  it("handles a URL with no database in it at all", () => {
    expect(withDatabaseName("postgres://u:p@localhost:5432", "t")).toBe(
      "postgres://u:p@localhost:5432/t"
    );
  });

  it("leaves a percent-encoded password encoded", () => {
    // A password with an `@` or a `/` in it is encoded in the URL, and re-encoding or
    // decoding it would produce a connection string that cannot authenticate.
    expect(withDatabaseName("postgres://u:p%40ss%2Fword@localhost:5432/app", "t")).toBe(
      "postgres://u:p%40ss%2Fword@localhost:5432/t"
    );
  });
});

describe("isolationIsEnabled", () => {
  it("is on under NODE_ENV=test, which is what `bun test` sets", () => {
    expect(isolationIsEnabled({ NODE_ENV: "test" })).toBe(true);
  });

  it("is off for any other environment, so it can never touch a real database", () => {
    // The preload is only ever loaded by `bun test`, but "create a database" is not
    // something to do on the strength of that alone.
    for (const nodeEnv of [undefined, "development", "production", "staging", "TEST"]) {
      expect(isolationIsEnabled({ NODE_ENV: nodeEnv })).toBe(false);
    }
  });

  it("can be switched off deliberately, for inspecting what a failing run left behind", () => {
    expect(
      isolationIsEnabled({ NODE_ENV: "test", DIUDARA_TEST_DB_ISOLATION: "off" })
    ).toBe(false);
  });

  it("treats any other value of the switch as on, rather than guessing", () => {
    // Failing closed here means failing ISOLATED: a typo must not quietly point the
    // suite at the development database and truncate it.
    expect(
      isolationIsEnabled({ NODE_ENV: "test", DIUDARA_TEST_DB_ISOLATION: "no" })
    ).toBe(true);
  });
});
