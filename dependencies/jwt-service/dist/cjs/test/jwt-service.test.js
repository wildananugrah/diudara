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
const index_1 = require("../index");
describe("JWT Service", () => {
    const data = {
        username: "wildananugrah",
        password: "p@ssw0rd",
    };
    const expired = 3600;
    let token = "";
    it("should create token", () => __awaiter(void 0, void 0, void 0, function* () {
        let jwtService = new index_1.JWTService({
            privateKey: "./keys/key.key",
            certificate: "./keys/certificate.crt",
        });
        const result = yield jwtService.create(data, expired);
        expect(typeof (result === null || result === void 0 ? void 0 : result.token)).toBe("string");
        token = result === null || result === void 0 ? void 0 : result.token;
        expect(result === null || result === void 0 ? void 0 : result.expired).toBe(expired);
    }));
    it("should validate token", () => __awaiter(void 0, void 0, void 0, function* () {
        let jwtService = new index_1.JWTService({
            privateKey: "./keys/key.key",
            certificate: "./keys/certificate.crt",
        });
        const result = yield jwtService.validate(token);
        expect(result === null || result === void 0 ? void 0 : result.username).toBe(data.username);
        expect(result === null || result === void 0 ? void 0 : result.password).toBe(data.password);
    }));
    it("should refresh token", () => __awaiter(void 0, void 0, void 0, function* () {
        let jwtService = new index_1.JWTService({
            privateKey: "./keys/key.key",
            certificate: "./keys/certificate.crt",
        });
        const result = yield jwtService.refresh(token, expired);
        expect(typeof (result === null || result === void 0 ? void 0 : result.token)).toBe("string");
        token = result === null || result === void 0 ? void 0 : result.token;
        expect(result === null || result === void 0 ? void 0 : result.expired).toBe(expired);
    }));
    it("should validate token again", () => __awaiter(void 0, void 0, void 0, function* () {
        let jwtService = new index_1.JWTService({
            privateKey: "./keys/key.key",
            certificate: "./keys/certificate.crt",
        });
        const result = yield jwtService.validate(token);
        expect(result === null || result === void 0 ? void 0 : result.username).toBe(data.username);
        expect(result === null || result === void 0 ? void 0 : result.password).toBe(data.password);
    }));
});
