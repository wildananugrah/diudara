import { Pool } from "pg";
import {
  IUserAttribute,
  IUserAttributeService,
  IUserService,
} from "user-management/src/interfaces";
import { UserAttributeService } from "../user-attribute.svc";
import { UserService } from "../user.svc";
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
  console.log("Starting truncate UserAttribute table...");
  const UserAttribute: IUserAttributeService = new UserAttributeService(pool);
  await UserAttribute.truncate();
  console.log("Starting truncate User table...");
  const user: IUserService = new UserService(pool);
  await user.truncate();
});

afterAll(async () => {
  await pool.end();
});

describe("User Service", () => {
  let userAttributeId: string | undefined = undefined;
  const userData = {
    email: "wildananugrah@gmail.com",
    password: "p@ssw0rd",
  };
  let data: IUserAttribute = {
    userId: "",
    appName: "testApp",
    attributeName: ["READ", "WRITE"],
  };
  let updatedData: IUserAttribute = {
    userId: "",
    appName: "testAppUpdate",
    attributeName: ["READ"],
  };
  it("it should create a user", async () => {
    const userService: IUserService = new UserService(pool);
    const dbUser = await userService.register(userData);
    if (dbUser === undefined) throw new Error(`Can not register user`);
    data.userId = dbUser.id === undefined ? "" : dbUser.id;
  });
  it("it should create a user attribute", async () => {
    const userAttributeService: IUserAttributeService =
      new UserAttributeService(pool);
    const dbUserAttribute = await userAttributeService.insert(data);
    if (dbUserAttribute === undefined)
      throw new Error(`Can not insert user attribute`);
    expect(dbUserAttribute.userId).toBe(data.userId);
    expect(dbUserAttribute.appName).toBe(data.appName);
    dbUserAttribute.attributeName.map((attributeName, index) => {
      expect(attributeName).toBe(data.attributeName[index]);
    });
    userAttributeId = dbUserAttribute.id;
  });
  it("it should select all user attribute", async () => {
    const userAttributeService: IUserAttributeService =
      new UserAttributeService(pool);
    const userAttributeList = await userAttributeService.list(data.userId);
    if (userAttributeList === undefined)
      throw new Error(`Can not retrieve user attributes`);
    userAttributeList.map((userAttribute, index) => {
      expect(userAttribute.appName).toBe(data.appName);
      expect(userAttribute.userId).toBe(data.userId);
      expect(typeof userAttribute.id).toBe("string");
      userAttribute.attributeName.map((attributeName, index) => {
        expect(attributeName).toBe(data.attributeName[index]);
      });
    });
  });
  it("it should update a user", async () => {
    if (userAttributeId === undefined) fail();
    const userAttributeService: IUserAttributeService =
      new UserAttributeService(pool);
    const dbUserAttribute = await userAttributeService.update(
      updatedData,
      userAttributeId
    );
    if (dbUserAttribute === undefined) fail();
    expect(dbUserAttribute.appName).toBe(updatedData.appName);
    expect(dbUserAttribute.userId).toBe(data.userId);
    dbUserAttribute.attributeName.map((attribute, index) => {
      expect(updatedData.attributeName[index]).toBe(attribute);
    });
  });
  it("it should select a user by id", async () => {
    if (userAttributeId === undefined) fail();
    const userAttributeService: IUserAttributeService =
      new UserAttributeService(pool);
    const dbUserAttribute = await userAttributeService.detail(userAttributeId);
    if (dbUserAttribute === undefined) fail();
    expect(dbUserAttribute.appName).toBe(updatedData.appName);
    expect(dbUserAttribute.userId).toBe(data.userId);
    dbUserAttribute.attributeName.map((attribute, index) => {
      expect(updatedData.attributeName[index]).toBe(attribute);
    });
  });
  it("it should delete a user by id", async () => {
    if (userAttributeId === undefined) fail();
    const userAttributeService: IUserAttributeService =
      new UserAttributeService(pool);
    const dbUserAttribute = await userAttributeService.delete(userAttributeId);
    const userAttributeService2: IUserAttributeService =
      new UserAttributeService(pool);
    const dbRoleAttribute = await userAttributeService2.detail(userAttributeId);
    expect(dbRoleAttribute).toBeUndefined();
  });
});
