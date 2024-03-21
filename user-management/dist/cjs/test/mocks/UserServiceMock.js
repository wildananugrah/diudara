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
exports.UserServiceMock = void 0;
class UserServiceMock {
    selectByEmail(email) {
        return __awaiter(this, void 0, void 0, function* () {
            if (email === "wildan@gmail.com")
                return undefined;
            return {
                id: "1234567890123456",
                email: "wildananugrah@gmail.com",
                password: "p@ssw0rd",
            };
        });
    }
    register(user) {
        return __awaiter(this, void 0, void 0, function* () {
            return {
                id: "1234567890123456",
                email: "wildananugrah@gmail.com",
                password: "p@ssw0rd",
            };
        });
    }
    login(user) {
        return __awaiter(this, void 0, void 0, function* () {
            if (user.email === "wildan@mail.com")
                return undefined;
            console.log(user);
            return {
                id: "1234567890123456",
                email: "wildananugrah@gmail.com",
                password: "p@ssw0rd",
            };
        });
    }
    truncate() {
        throw new Error("Method not implemented.");
    }
}
exports.UserServiceMock = UserServiceMock;
