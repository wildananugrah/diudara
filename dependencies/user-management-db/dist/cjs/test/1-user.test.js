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
    console.log("Starting truncate table...");
    const userService = new user_svc_1.UserService(pool);
    yield userService.truncate();
}));
afterAll(() => __awaiter(void 0, void 0, void 0, function* () {
    yield pool.end();
}));
describe("User Service", () => {
    let todoId = "";
    const data = {
        identifier: "wildananugrah@gmail.com",
        password: "p@ssw0rd",
    };
    it("should be registered new user", () => __awaiter(void 0, void 0, void 0, function* () {
        const userService = new user_svc_1.UserService(pool);
        const user = yield userService.register(data);
        if (user === undefined)
            fail();
        expect(user.identifier).toBe(data.identifier);
        expect(user.password).toBe(data.password);
    }));
    it("should be logged in a user", () => __awaiter(void 0, void 0, void 0, function* () {
        const userService = new user_svc_1.UserService(pool);
        const user = yield userService.selectByIdentifier(data.identifier);
        if (user === undefined)
            fail();
        expect(typeof user.id).toBe("string");
        expect(user.identifier).toBe(data.identifier);
        expect(user.password).toBe(data.password);
    }));
});
