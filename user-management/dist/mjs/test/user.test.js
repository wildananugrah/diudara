import { UserServiceMock } from "./mocks/UserServiceMock";
import { AppError, INVALID_PASSWORD_CODE, INVALID_PASSWORD_MESSAGE, INVALID_IDENTIFIER_CODE, INVALID_IDENTIFIER_MESSAGE, REGISTER_FAILED_INVALID_PASSWORD, REGISTER_FAILED_INVALID_PASSWORD_CODE, User, } from "../user";
import { JWTServiceMock } from "./mocks/JWTServiceMock";
import { UserRoleTrxServiceMock } from "./mocks/UserRoleTrxServiceMock";
beforeAll(async () => { });
afterAll(async () => { });
describe("User Logic Layer", () => {
    const userData = {
        email: "wildananugrah@gmail.com",
        password: "p@ssw0rd",
        confirmPassword: "p@ssw0rd",
    };
    const userRegisterData = {
        email: "wildan@gmail.com",
        password: "p@ssw0rd",
        confirmPassword: "p@ssw0rd",
    };
    let token = undefined;
    it("should registering a user invalid confirm password", async () => {
        try {
            const userService = new UserServiceMock();
            const jwtService = new JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock();
            const userLogic = new User(userService, userRoleTrxService, jwtService);
            const result = await userLogic.register(userData.email, userData.password, "password");
            if (result === undefined)
                throw new Error(`User registration failed: ${result}`);
        }
        catch (error) {
            console.error(error);
            if (error instanceof AppError) {
                expect(error.code).toBe(REGISTER_FAILED_INVALID_PASSWORD_CODE);
                expect(error.message).toBe(REGISTER_FAILED_INVALID_PASSWORD);
            }
        }
    });
    it("should registering a user", async () => {
        try {
            const userService = new UserServiceMock();
            const jwtService = new JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock();
            const userLogic = new User(userService, userRoleTrxService, jwtService);
            const result = await userLogic.register(userRegisterData.email, userRegisterData.password, userRegisterData.confirmPassword);
            if (result === undefined)
                fail();
            expect(typeof result.token).toBe("string");
            expect(typeof result.expired).toBe("number");
        }
        catch (error) {
            console.error(error);
            fail();
        }
    });
    it("should logging in a user", async () => {
        try {
            const userService = new UserServiceMock();
            const jwtService = new JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock();
            const userLogic = new User(userService, userRoleTrxService, jwtService);
            const result = await userLogic.login(userData.email, userData.password);
            if (result === undefined)
                fail();
            expect(typeof result.token).toBe("string");
            expect(typeof result.expired).toBe("number");
            token = result.token;
        }
        catch (error) {
            console.error(error);
            fail();
        }
    });
    it("should return decoded token", async () => {
        try {
            const userService = new UserServiceMock();
            const jwtService = new JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock();
            const userLogic = new User(userService, userRoleTrxService, jwtService);
            if (token === undefined)
                throw new Error("token is undefined");
            const result = await userLogic.validateToken(token);
            console.log(result);
        }
        catch (error) {
            console.error(error);
            fail();
        }
    });
    it("should return decoded token", async () => {
        try {
            const userService = new UserServiceMock();
            const jwtService = new JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock();
            const userLogic = new User(userService, userRoleTrxService, jwtService);
            if (token === undefined)
                throw new Error("token is undefined");
            const result = await userLogic.refreshToken(token, 3600);
            console.log(result);
        }
        catch (error) {
            console.error(error);
            fail();
        }
    });
    it("should logging in a user failed", async () => {
        try {
            const userService = new UserServiceMock();
            const jwtService = new JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock();
            const userLogic = new User(userService, userRoleTrxService, jwtService);
            const result = await userLogic.login("wildan", userData.password);
            if (result === undefined)
                fail();
            expect(typeof result.token).toBe("string");
            expect(typeof result.expired).toBe("number");
        }
        catch (error) {
            console.error(error);
            expect(error).toBeInstanceOf(AppError);
            if (error instanceof AppError) {
                expect(error.code).toBe(INVALID_IDENTIFIER_CODE);
                expect(error.message).toBe(INVALID_IDENTIFIER_MESSAGE);
            }
        }
    });
    it("should logging in a user invalid password", async () => {
        try {
            const userService = new UserServiceMock();
            const jwtService = new JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock();
            const userLogic = new User(userService, userRoleTrxService, jwtService);
            const result = await userLogic.login(userData.email, "password");
            if (result === undefined)
                fail();
            expect(typeof result.token).toBe("string");
            expect(typeof result.expired).toBe("number");
        }
        catch (error) {
            console.error(error);
            expect(error).toBeInstanceOf(AppError);
            if (error instanceof AppError) {
                expect(error.code).toBe(INVALID_PASSWORD_CODE);
                expect(error.message).toBe(INVALID_PASSWORD_MESSAGE);
            }
        }
    });
});
