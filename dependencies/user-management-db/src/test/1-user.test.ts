import { Pool } from "pg";
import { UserService } from "../user.svc";
import { IUser, IUserService } from "user-management/src/interfaces";

import {
  dbConnectionTimeout,
  dbDatabase,
  dbIdleTimeout,
  dbMaxUses,
  dbPass,
  dbPoolMax,
  dbPoolMin,
  dbPort,
  dbUser,
  dbhost,
} from "./db.config";

const config = {
  host: dbhost,
  database: dbDatabase,
  port: dbPort,
  user: dbUser,
  password: dbPass,
  ssl: false,
  min: dbPoolMin,
  max: dbPoolMax,
  idleTimeoutMillis: dbIdleTimeout,
  connectionTimeoutMillis: dbConnectionTimeout,
  maxUses: dbMaxUses,
};
const pool = new Pool(config);

beforeAll(async () => {
  console.log(`Connecting to ${dbhost}:${dbPort} databases...`);
  console.log(config);
  console.log("Starting truncate table...");
  const userService: IUserService = new UserService(pool);
  await userService.truncate();
});

afterAll(async () => {
  await pool.end();
});

describe("User Service", () => {
  let todoId: string | undefined = "";
  const data: IUser = {
    identifier: "wildananugrah@gmail.com",
    password: "p@ssw0rd",
  };
  it("should be registered new user", async () => {
    const userService: IUserService = new UserService(pool);
    const user = await userService.register(data);
    if (user === undefined) fail();
    expect(user.identifier).toBe(data.identifier);
    expect(user.password).toBe(data.password);
  });
  it("should be logged in a user", async () => {
    const userService: IUserService = new UserService(pool);
    const user = await userService.selectByIdentifier(data.identifier);
    if (user === undefined) fail();
    expect(typeof user.id).toBe("string");
    expect(user.identifier).toBe(data.identifier);
    expect(user.password).toBe(data.password);
  });
});
