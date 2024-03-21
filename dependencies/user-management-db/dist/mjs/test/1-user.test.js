import { Pool } from "pg";
import { UserService } from "../user.svc";
import { dbConnectionTimeout, dbDatabase, dbIdleTimeout, dbMaxUses, dbPass, dbPoolMax, dbPoolMin, dbPort, dbUser, dbhost, } from "./db.config";
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
    const userService = new UserService(pool);
    await userService.truncate();
});
afterAll(async () => {
    await pool.end();
});
describe("User Service", () => {
    let todoId = "";
    const data = {
        email: "wildananugrah@gmail.com",
        password: "p@ssw0rd",
    };
    it("should be registered new user", async () => {
        const userService = new UserService(pool);
        const user = await userService.register(data);
        if (user === undefined)
            fail();
        expect(user.email).toBe(data.email);
        expect(user.password).toBe(data.password);
    });
    it("should be logged in a user", async () => {
        const userService = new UserService(pool);
        const user = await userService.selectByEmail(data.email);
        if (user === undefined)
            fail();
        expect(typeof user.id).toBe("string");
        expect(user.email).toBe(data.email);
        expect(user.password).toBe(data.password);
    });
});
