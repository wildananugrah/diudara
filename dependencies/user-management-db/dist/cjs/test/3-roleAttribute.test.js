"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const role_attribute_svc_1 = require("../role-attribute.svc");
const role_svc_1 = require("../role.svc");
const db_config_1 = require("./db.config");
const config = {
    host: db_config_1.dbhost,
    database: db_config_1.dbDatabase,
    port: db_config_1.dbPort,
    user: db_config_1.dbUser,
    password: db_config_1.dbPass,
    ssl: false,
    min: db_config_1.dbPoolMin,
    max: db_config_1.dbPoolMax,
    idleTimeoutMillis: db_config_1.dbIdleTimeout,
    connectionTimeoutMillis: db_config_1.dbConnectionTimeout,
    maxUses: db_config_1.dbMaxUses,
};
const pool = new pg_1.Pool(config);
beforeAll(() => __awaiter(void 0, void 0, void 0, function* () {
    console.log(`Connecting to ${db_config_1.dbhost}:${db_config_1.dbPort} databases...`);
    console.log(config);
    console.log("Starting truncate RoleAttribute table...");
    const roleAttribute = new role_attribute_svc_1.RoleAttributeService(pool);
    yield roleAttribute.truncate();
    console.log("Starting truncate Role table...");
    const role = new role_svc_1.RoleService(pool);
    yield role.truncate();
}));
afterAll(() => __awaiter(void 0, void 0, void 0, function* () {
    yield pool.end();
}));
describe("Role Service", () => {
    let roleAttributeId = undefined;
    const roleData = {
        roleName: "ADMIN",
    };
    let data = {
        roleId: "",
        appName: "testApp",
        attributeName: ["READ", "WRITE"],
    };
    let updatedData = {
        roleId: "",
        appName: "testAppUpdate",
        attributeName: ["READ"],
    };
    it("it should create a role", () => __awaiter(void 0, void 0, void 0, function* () {
        const roleService = new role_svc_1.RoleService(pool);
        const dbRole = yield roleService.insert(roleData);
        if (dbRole === undefined)
            fail();
        expect(dbRole.roleName).toBe(roleData.roleName);
        data.roleId = dbRole.id !== undefined ? dbRole.id : "";
    }));
    it("it should create a role attribute", () => __awaiter(void 0, void 0, void 0, function* () {
        const roleAttributeService = new role_attribute_svc_1.RoleAttributeService(pool);
        const dbRoleAttribute = yield roleAttributeService.insert(data);
        if (dbRoleAttribute === undefined)
            fail();
        expect(dbRoleAttribute.roleId).toBe(data.roleId);
        expect(dbRoleAttribute.appName).toBe(data.appName);
        data.attributeName.map((attribute, index) => {
            expect(dbRoleAttribute.attributeName[index]).toBe(attribute);
        });
        roleAttributeId = dbRoleAttribute.id;
    }));
    it("it should select all role attribute", () => __awaiter(void 0, void 0, void 0, function* () {
        const roleService = new role_attribute_svc_1.RoleAttributeService(pool);
        const dbRoleAttribute = yield roleService.list(data.roleId);
        if (dbRoleAttribute === undefined)
            fail();
        expect(dbRoleAttribute.length > 0).toBe(true);
        dbRoleAttribute.map((roleAttribute) => {
            expect(roleAttribute.appName).toBe(data.appName);
            roleAttribute.attributeName.map((attribute, index) => {
                expect(roleAttribute.attributeName[index]).toBe(attribute);
            });
        });
    }));
    it("it should update a role", () => __awaiter(void 0, void 0, void 0, function* () {
        if (roleAttributeId === undefined)
            fail();
        const roleAttributeService = new role_attribute_svc_1.RoleAttributeService(pool);
        const dbRoleAttribute = yield roleAttributeService.update(updatedData, roleAttributeId);
        if (dbRoleAttribute === undefined)
            fail();
        expect(dbRoleAttribute.appName).toBe(updatedData.appName);
        dbRoleAttribute.attributeName.map((attribute, index) => {
            expect(updatedData.attributeName[index]).toBe(attribute);
        });
    }));
    it("it should select a role by id", () => __awaiter(void 0, void 0, void 0, function* () {
        if (roleAttributeId === undefined)
            fail();
        const roleAttributeService = new role_attribute_svc_1.RoleAttributeService(pool);
        const dbRoleAttribute = yield roleAttributeService.detail(roleAttributeId);
        if (dbRoleAttribute === undefined)
            fail();
        expect(dbRoleAttribute.appName).toBe(updatedData.appName);
        dbRoleAttribute.attributeName.map((attribute, index) => {
            expect(updatedData.attributeName[index]).toBe(attribute);
        });
    }));
    it("it should delete a role by id", () => __awaiter(void 0, void 0, void 0, function* () {
        if (roleAttributeId === undefined)
            fail();
        const roleAttributeService = new role_attribute_svc_1.RoleAttributeService(pool);
        yield roleAttributeService.delete(roleAttributeId);
        const roleAttributeService2 = new role_attribute_svc_1.RoleAttributeService(pool);
        const dbRoleAttribute = yield roleAttributeService2.detail(roleAttributeId);
        expect(dbRoleAttribute).toBeUndefined();
    }));
});
