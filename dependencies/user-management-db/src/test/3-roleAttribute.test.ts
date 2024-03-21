import { Pool } from "pg";
import { RoleAttributeService } from "../role-attribute.svc";
import { RoleService } from "../role.svc";
import {
  IRoleAttribute,
  IRoleAttributeService,
  IRoleService,
} from "user-management/src/interfaces";
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
  console.log("Starting truncate RoleAttribute table...");
  const roleAttribute: IRoleAttributeService = new RoleAttributeService(pool);
  await roleAttribute.truncate();
  console.log("Starting truncate Role table...");
  const role: IRoleService = new RoleService(pool);
  await role.truncate();
});

afterAll(async () => {
  await pool.end();
});

describe("Role Service", () => {
  let roleAttributeId: string | undefined = undefined;
  const roleData = {
    roleName: "ADMIN",
  };
  let data: IRoleAttribute = {
    roleId: "",
    appName: "testApp",
    attributeName: ["READ", "WRITE"],
  };
  let updatedData: IRoleAttribute = {
    roleId: "",
    appName: "testAppUpdate",
    attributeName: ["READ"],
  };
  it("it should create a role", async () => {
    const roleService: IRoleService = new RoleService(pool);
    const dbRole = await roleService.insert(roleData);
    if (dbRole === undefined) fail();
    expect(dbRole.roleName).toBe(roleData.roleName);
    data.roleId = dbRole.id !== undefined ? dbRole.id : "";
  });
  it("it should create a role attribute", async () => {
    const roleAttributeService: IRoleAttributeService =
      new RoleAttributeService(pool);
    const dbRoleAttribute = await roleAttributeService.insert(data);
    if (dbRoleAttribute === undefined) fail();
    expect(dbRoleAttribute.roleId).toBe(data.roleId);
    expect(dbRoleAttribute.appName).toBe(data.appName);
    data.attributeName.map((attribute, index) => {
      expect(dbRoleAttribute.attributeName[index]).toBe(attribute);
    });
    roleAttributeId = dbRoleAttribute.id;
  });
  it("it should select all role attribute", async () => {
    const roleService: IRoleAttributeService = new RoleAttributeService(pool);
    const dbRoleAttribute: IRoleAttribute[] | undefined =
      await roleService.list(data.roleId);
    if (dbRoleAttribute === undefined) fail();
    expect(dbRoleAttribute.length > 0).toBe(true);
    dbRoleAttribute.map((roleAttribute: IRoleAttribute) => {
      expect(roleAttribute.appName).toBe(data.appName);
      roleAttribute.attributeName.map((attribute, index) => {
        expect(roleAttribute.attributeName[index]).toBe(attribute);
      });
    });
  });
  it("it should update a role", async () => {
    if (roleAttributeId === undefined) fail();
    const roleAttributeService: IRoleAttributeService =
      new RoleAttributeService(pool);
    const dbRoleAttribute = await roleAttributeService.update(
      updatedData,
      roleAttributeId
    );
    if (dbRoleAttribute === undefined) fail();
    expect(dbRoleAttribute.appName).toBe(updatedData.appName);
    dbRoleAttribute.attributeName.map((attribute, index) => {
      expect(updatedData.attributeName[index]).toBe(attribute);
    });
  });
  it("it should select a role by id", async () => {
    if (roleAttributeId === undefined) fail();
    const roleAttributeService: IRoleAttributeService =
      new RoleAttributeService(pool);
    const dbRoleAttribute = await roleAttributeService.detail(roleAttributeId);
    if (dbRoleAttribute === undefined) fail();
    expect(dbRoleAttribute.appName).toBe(updatedData.appName);
    dbRoleAttribute.attributeName.map((attribute, index) => {
      expect(updatedData.attributeName[index]).toBe(attribute);
    });
  });
  it("it should delete a role by id", async () => {
    if (roleAttributeId === undefined) fail();
    const roleAttributeService: IRoleAttributeService =
      new RoleAttributeService(pool);
    await roleAttributeService.delete(roleAttributeId);
    const roleAttributeService2: IRoleAttributeService =
      new RoleAttributeService(pool);
    const dbRoleAttribute = await roleAttributeService2.detail(roleAttributeId);
    expect(dbRoleAttribute).toBeUndefined();
  });
});
