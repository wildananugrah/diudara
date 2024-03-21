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
const user_attribute_svc_1 = require("../user-attribute.svc");
const user_svc_1 = require("../user.svc");
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
    console.log("Starting truncate UserAttribute table...");
    const UserAttribute = new user_attribute_svc_1.UserAttributeService(pool);
    yield UserAttribute.truncate();
    console.log("Starting truncate User table...");
    const user = new user_svc_1.UserService(pool);
    yield user.truncate();
}));
afterAll(() => __awaiter(void 0, void 0, void 0, function* () {
    yield pool.end();
}));
describe("User Service", () => {
    let userAttributeId = undefined;
    const userData = {
        email: "wildananugrah@gmail.com",
        password: "p@ssw0rd",
    };
    let data = {
        userId: "",
        appName: "testApp",
        attributeName: ["READ", "WRITE"],
    };
    let updatedData = {
        userId: "",
        appName: "testAppUpdate",
        attributeName: ["READ"],
    };
    it("it should create a user", () => __awaiter(void 0, void 0, void 0, function* () {
        const userService = new user_svc_1.UserService(pool);
        const dbUser = yield userService.register(userData);
        if (dbUser === undefined)
            throw new Error(`Can not register user`);
        data.userId = dbUser.id === undefined ? "" : dbUser.id;
    }));
    it("it should create a user attribute", () => __awaiter(void 0, void 0, void 0, function* () {
        const userAttributeService = new user_attribute_svc_1.UserAttributeService(pool);
        const dbUserAttribute = yield userAttributeService.insert(data);
        if (dbUserAttribute === undefined)
            throw new Error(`Can not insert user attribute`);
        expect(dbUserAttribute.userId).toBe(data.userId);
        expect(dbUserAttribute.appName).toBe(data.appName);
        dbUserAttribute.attributeName.map((attributeName, index) => {
            expect(attributeName).toBe(data.attributeName[index]);
        });
        userAttributeId = dbUserAttribute.id;
    }));
    it("it should select all user attribute", () => __awaiter(void 0, void 0, void 0, function* () {
        const userAttributeService = new user_attribute_svc_1.UserAttributeService(pool);
        const userAttributeList = yield userAttributeService.list(data.userId);
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
    }));
    it("it should update a user", () => __awaiter(void 0, void 0, void 0, function* () {
        if (userAttributeId === undefined)
            fail();
        const userAttributeService = new user_attribute_svc_1.UserAttributeService(pool);
        const dbUserAttribute = yield userAttributeService.update(updatedData, userAttributeId);
        if (dbUserAttribute === undefined)
            fail();
        expect(dbUserAttribute.appName).toBe(updatedData.appName);
        expect(dbUserAttribute.userId).toBe(data.userId);
        dbUserAttribute.attributeName.map((attribute, index) => {
            expect(updatedData.attributeName[index]).toBe(attribute);
        });
    }));
    it("it should select a user by id", () => __awaiter(void 0, void 0, void 0, function* () {
        if (userAttributeId === undefined)
            fail();
        const userAttributeService = new user_attribute_svc_1.UserAttributeService(pool);
        const dbUserAttribute = yield userAttributeService.detail(userAttributeId);
        if (dbUserAttribute === undefined)
            fail();
        expect(dbUserAttribute.appName).toBe(updatedData.appName);
        expect(dbUserAttribute.userId).toBe(data.userId);
        dbUserAttribute.attributeName.map((attribute, index) => {
            expect(updatedData.attributeName[index]).toBe(attribute);
        });
    }));
    it("it should delete a user by id", () => __awaiter(void 0, void 0, void 0, function* () {
        if (userAttributeId === undefined)
            fail();
        const userAttributeService = new user_attribute_svc_1.UserAttributeService(pool);
        const dbUserAttribute = yield userAttributeService.delete(userAttributeId);
        const userAttributeService2 = new user_attribute_svc_1.UserAttributeService(pool);
        const dbRoleAttribute = yield userAttributeService2.detail(userAttributeId);
        expect(dbRoleAttribute).toBeUndefined();
    }));
});
