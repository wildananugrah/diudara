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
const UserServiceMock_1 = require("./mocks/UserServiceMock");
const user_1 = require("../user");
const JWTServiceMock_1 = require("./mocks/JWTServiceMock");
const UserRoleTrxServiceMock_1 = require("./mocks/UserRoleTrxServiceMock");
beforeAll(() => __awaiter(void 0, void 0, void 0, function* () { }));
afterAll(() => __awaiter(void 0, void 0, void 0, function* () { }));
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
    it("should registering a user invalid confirm password", () => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const userService = new UserServiceMock_1.UserServiceMock();
            const jwtService = new JWTServiceMock_1.JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock_1.UserRoleTrxServiceMock();
            const userLogic = new user_1.User(userService, userRoleTrxService, jwtService);
            const result = yield userLogic.register(userData.email, userData.password, "password");
            if (result === undefined)
                throw new Error(`User registration failed: ${result}`);
        }
        catch (error) {
            console.error(error);
            if (error instanceof user_1.AppError) {
                expect(error.code).toBe(user_1.REGISTER_FAILED_INVALID_PASSWORD_CODE);
                expect(error.message).toBe(user_1.REGISTER_FAILED_INVALID_PASSWORD);
            }
        }
    }));
    it("should registering a user", () => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const userService = new UserServiceMock_1.UserServiceMock();
            const jwtService = new JWTServiceMock_1.JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock_1.UserRoleTrxServiceMock();
            const userLogic = new user_1.User(userService, userRoleTrxService, jwtService);
            const result = yield userLogic.register(userRegisterData.email, userRegisterData.password, userRegisterData.confirmPassword);
            if (result === undefined)
                fail();
            expect(typeof result.token).toBe("string");
            expect(typeof result.expired).toBe("number");
        }
        catch (error) {
            console.error(error);
            fail();
        }
    }));
    it("should logging in a user", () => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const userService = new UserServiceMock_1.UserServiceMock();
            const jwtService = new JWTServiceMock_1.JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock_1.UserRoleTrxServiceMock();
            const userLogic = new user_1.User(userService, userRoleTrxService, jwtService);
            const result = yield userLogic.login(userData.email, userData.password);
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
    }));
    it("should return decoded token", () => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const userService = new UserServiceMock_1.UserServiceMock();
            const jwtService = new JWTServiceMock_1.JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock_1.UserRoleTrxServiceMock();
            const userLogic = new user_1.User(userService, userRoleTrxService, jwtService);
            if (token === undefined)
                throw new Error("token is undefined");
            const result = yield userLogic.validateToken(token);
            console.log(result);
        }
        catch (error) {
            console.error(error);
            fail();
        }
    }));
    it("should return decoded token", () => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const userService = new UserServiceMock_1.UserServiceMock();
            const jwtService = new JWTServiceMock_1.JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock_1.UserRoleTrxServiceMock();
            const userLogic = new user_1.User(userService, userRoleTrxService, jwtService);
            if (token === undefined)
                throw new Error("token is undefined");
            const result = yield userLogic.refreshToken(token, 3600);
            console.log(result);
        }
        catch (error) {
            console.error(error);
            fail();
        }
    }));
    it("should logging in a user failed", () => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const userService = new UserServiceMock_1.UserServiceMock();
            const jwtService = new JWTServiceMock_1.JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock_1.UserRoleTrxServiceMock();
            const userLogic = new user_1.User(userService, userRoleTrxService, jwtService);
            const result = yield userLogic.login("wildan", userData.password);
            if (result === undefined)
                fail();
            expect(typeof result.token).toBe("string");
            expect(typeof result.expired).toBe("number");
        }
        catch (error) {
            console.error(error);
            expect(error).toBeInstanceOf(user_1.AppError);
            if (error instanceof user_1.AppError) {
                expect(error.code).toBe(user_1.INVALID_IDENTIFIER_CODE);
                expect(error.message).toBe(user_1.INVALID_IDENTIFIER_MESSAGE);
            }
        }
    }));
    it("should logging in a user invalid password", () => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const userService = new UserServiceMock_1.UserServiceMock();
            const jwtService = new JWTServiceMock_1.JWTServiceMock();
            const userRoleTrxService = new UserRoleTrxServiceMock_1.UserRoleTrxServiceMock();
            const userLogic = new user_1.User(userService, userRoleTrxService, jwtService);
            const result = yield userLogic.login(userData.email, "password");
            if (result === undefined)
                fail();
            expect(typeof result.token).toBe("string");
            expect(typeof result.expired).toBe("number");
        }
        catch (error) {
            console.error(error);
            expect(error).toBeInstanceOf(user_1.AppError);
            if (error instanceof user_1.AppError) {
                expect(error.code).toBe(user_1.INVALID_PASSWORD_CODE);
                expect(error.message).toBe(user_1.INVALID_PASSWORD_MESSAGE);
            }
        }
    }));
});
