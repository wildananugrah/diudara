import { Pool } from "pg";
import {
  IRoleAttribute,
  IRoleAttributeService,
  IRoleService,
  IUser,
  IUserAttribute,
  IUserAttributeService,
  IUserRoleTrxService,
  IUserService,
} from "user-management/src/interfaces";

import { UserRoleTrxService } from "../user-role-trx.svc";
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
import { UserService } from "../user.svc";
import { RoleService } from "../role.svc";
import { RoleAttributeService } from "../role-attribute.svc";
import { UserAttributeService } from "../user-attribute.svc";

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

beforeAll(async () => {});

afterAll(async () => {
  await pool.end();
});

describe("Set and Get User Attributes", () => {
  let userId: string | undefined = "";
  let roleId: string | undefined = "";
  const userData: IUser = {
    identifier: "wildananugrah@gmail.com",
    password: "p@ssw0rd",
  };
  const roleData = {
    roleName: "ADMIN",
  };
  let roleAttributeData: IRoleAttribute = {
    roleId: "",
    appName: "testApp",
    attributeName: ["READ", "WRITE"],
  };
  let roleAttributeData1: IRoleAttribute = {
    roleId: "",
    appName: "testApp1",
    attributeName: ["READ", "WRITE"],
  };
  let roleAttributeData2: IRoleAttribute = {
    roleId: "",
    appName: "testApp2",
    attributeName: ["READ", "WRITE"],
  };
  let userAttributeData: IUserAttribute = {
    userId: "",
    appName: "testApp3",
    attributeName: ["READ"],
  };
  it("it should create a role", async () => {
    const roleService: IRoleService = new RoleService(pool);
    const dbRole = await roleService.insert(roleData);
    if (dbRole === undefined) fail();
    expect(dbRole.roleName).toBe(roleData.roleName);
    roleId = dbRole.id;
  });
  it("it should create a role attribute", async () => {
    const roleAttributeService: IRoleAttributeService =
      new RoleAttributeService(pool);
    if (roleId === undefined) throw new Error("RoleId is undefined");
    roleAttributeData.roleId = roleId;
    const dbRoleAttribute = await roleAttributeService.insert(
      roleAttributeData
    );
    if (dbRoleAttribute === undefined) fail();
    expect(dbRoleAttribute.roleId).toBe(roleAttributeData.roleId);
    expect(dbRoleAttribute.appName).toBe(roleAttributeData.appName);
    roleAttributeData.attributeName.map((attribute, index) => {
      expect(dbRoleAttribute.attributeName[index]).toBe(attribute);
    });
  });
  it("it should create a role attribute 1", async () => {
    const roleAttributeService: IRoleAttributeService =
      new RoleAttributeService(pool);
    if (roleId === undefined) throw new Error("RoleId is undefined");
    roleAttributeData1.roleId = roleId;
    const dbRoleAttribute = await roleAttributeService.insert(
      roleAttributeData1
    );
    if (dbRoleAttribute === undefined) fail();
    expect(dbRoleAttribute.roleId).toBe(roleAttributeData1.roleId);
    expect(dbRoleAttribute.appName).toBe(roleAttributeData1.appName);
    roleAttributeData1.attributeName.map((attribute, index) => {
      expect(dbRoleAttribute.attributeName[index]).toBe(attribute);
    });
  });
  it("it should create a role attribute 2", async () => {
    const roleAttributeService: IRoleAttributeService =
      new RoleAttributeService(pool);
    if (roleId === undefined) throw new Error("RoleId is undefined");
    roleAttributeData2.roleId = roleId;
    const dbRoleAttribute = await roleAttributeService.insert(
      roleAttributeData2
    );
    if (dbRoleAttribute === undefined) fail();
    expect(dbRoleAttribute.roleId).toBe(roleAttributeData2.roleId);
    expect(dbRoleAttribute.appName).toBe(roleAttributeData2.appName);
    roleAttributeData2.attributeName.map((attribute, index) => {
      expect(dbRoleAttribute.attributeName[index]).toBe(attribute);
    });
  });
  it("should be logged in a user", async () => {
    const userService: IUserService = new UserService(pool);
    const user = await userService.login(userData);
    if (user === undefined) fail();
    expect(typeof user.id).toBe("string");
    expect(user.identifier).toBe(userData.identifier);
    expect(user.password).toBe(userData.password);
    userId = user.id;
  });
  it("it should create a user attribute", async () => {
    const userAttributeService: IUserAttributeService =
      new UserAttributeService(pool);
    if (userId === undefined) throw new Error("userid is undefined");
    userAttributeData.userId = userId;
    const dbUserAttribute = await userAttributeService.insert(
      userAttributeData
    );
    if (dbUserAttribute === undefined)
      throw new Error(`Can not insert user attribute`);
    expect(dbUserAttribute.userId).toBe(userAttributeData.userId);
    expect(dbUserAttribute.appName).toBe(userAttributeData.appName);
    dbUserAttribute.attributeName.map((attributeName, index) => {
      expect(attributeName).toBe(userAttributeData.attributeName[index]);
    });
  });
  it("it should create a user role trx", async () => {
    const userRoleTrxService: IUserRoleTrxService = new UserRoleTrxService(
      pool
    );
    if (userId === undefined) throw new Error("userid is undefined");
    if (roleId === undefined) throw new Error("roleid is undefined");

    const dbUserRole = await userRoleTrxService.insert({
      roleId: roleId,
      userId: userId,
    });
    if (dbUserRole === undefined) throw new Error(`Can not insert user role`);
    expect(dbUserRole.userId).toBe(userId);
    expect(dbUserRole.roleId).toBe(roleId);
    expect(typeof dbUserRole.id).toBe("string");
  });
  it("should get user attributes", async () => {
    if (userId === undefined) throw new Error("userId must be defined");
    const userRoleService: IUserRoleTrxService = new UserRoleTrxService(pool);
    const userAttributes = await userRoleService.list(userId);
    console.log(userAttributes);
  });
});
