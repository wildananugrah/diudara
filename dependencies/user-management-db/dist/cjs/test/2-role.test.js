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
const db_config_1 = require("./db.config");
const role_svc_1 = require("../role.svc");
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
    console.log("Starting truncate table...");
    const roleService = new role_svc_1.RoleService(pool);
    yield roleService.truncate();
}));
afterAll(() => __awaiter(void 0, void 0, void 0, function* () {
    yield pool.end();
}));
describe("Role Service", () => {
    let roleId = undefined;
    const data = {
        roleName: "ADMIN",
    };
    const updatedData = {
        roleName: "SUPERADMIN",
    };
    it("it should create a role", () => __awaiter(void 0, void 0, void 0, function* () {
        const roleService = new role_svc_1.RoleService(pool);
        const dbRole = yield roleService.insert(data);
        if (dbRole === undefined)
            fail();
        expect(dbRole.roleName).toBe(data.roleName);
    }));
    it("it should select all role", () => __awaiter(void 0, void 0, void 0, function* () {
        const roleService = new role_svc_1.RoleService(pool);
        const dbRole = yield roleService.list();
        if (dbRole === undefined)
            fail();
        expect(dbRole.length > 0).toBe(true);
        dbRole.map((role) => {
            expect(role.roleName).toBe(data.roleName);
            roleId = role.id;
        });
    }));
    it("it should update a role", () => __awaiter(void 0, void 0, void 0, function* () {
        if (roleId === undefined)
            fail();
        const roleService = new role_svc_1.RoleService(pool);
        const dbRole = yield roleService.update(updatedData, roleId);
        if (dbRole === undefined)
            fail();
        expect(dbRole.roleName).toBe(updatedData.roleName);
    }));
    it("it should select a role by id", () => __awaiter(void 0, void 0, void 0, function* () {
        if (roleId === undefined)
            fail();
        const roleService = new role_svc_1.RoleService(pool);
        const dbRole = yield roleService.detail(roleId);
        if (dbRole === undefined)
            fail();
        expect(dbRole.roleName).toBe(updatedData.roleName);
    }));
    it("it should delete a role by id", () => __awaiter(void 0, void 0, void 0, function* () {
        if (roleId === undefined)
            fail();
        const roleService = new role_svc_1.RoleService(pool);
        yield roleService.delete(roleId);
        const roleService2 = new role_svc_1.RoleService(pool);
        const dbRole = yield roleService2.detail(roleId);
    }));
});
