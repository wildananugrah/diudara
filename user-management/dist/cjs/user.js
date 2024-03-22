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
exports.User = exports.AppError = exports.REGISTER_FAILED_INVALID_PASSWORD = exports.REGISTER_FAILED_INVALID_PASSWORD_CODE = exports.REGISTER_FAILED_MESSAGE = exports.REGISTER_FAILED_CODE = exports.REGISTER_FAILED_IDENTIFIER_EXISTS = exports.REGISTER_FAILED_IDENTIFIER_EXISTS_CODE = exports.INVALID_PASSWORD_MESSAGE = exports.INVALID_PASSWORD_CODE = exports.INVALID_IDENTIFIER_MESSAGE = exports.INVALID_IDENTIFIER_CODE = void 0;
exports.INVALID_IDENTIFIER_CODE = "UM404";
exports.INVALID_IDENTIFIER_MESSAGE = "Identifier is invalid!";
exports.INVALID_PASSWORD_CODE = "UM400";
exports.INVALID_PASSWORD_MESSAGE = "Password is invalid!";
exports.REGISTER_FAILED_IDENTIFIER_EXISTS_CODE = "UM400";
exports.REGISTER_FAILED_IDENTIFIER_EXISTS = "Identifier has been registered!";
exports.REGISTER_FAILED_CODE = "UM400";
exports.REGISTER_FAILED_MESSAGE = "System can not register the user!";
exports.REGISTER_FAILED_INVALID_PASSWORD_CODE = "UM400";
exports.REGISTER_FAILED_INVALID_PASSWORD = "Password and Confirm Password are not matched!";
class AppError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.message = message;
        Object.setPrototypeOf(this, AppError.prototype);
    }
}
exports.AppError = AppError;
class User {
    constructor(userService, userRoleTrxService, jwtService) {
        this.userService = userService;
        this.jwtService = jwtService;
        this.userRoleTrxService = userRoleTrxService;
    }
    login(identifier, password) {
        return __awaiter(this, void 0, void 0, function* () {
            const user = yield this.userService.selectByIdentifier(identifier);
            if (user === undefined || user.id === undefined)
                throw new AppError(exports.INVALID_IDENTIFIER_CODE, exports.INVALID_IDENTIFIER_MESSAGE);
            if (user.password !== password)
                throw new AppError(exports.INVALID_PASSWORD_CODE, exports.INVALID_PASSWORD_MESSAGE);
            const userRole = yield this.userRoleTrxService.list(user.id);
            return yield this.jwtService.create({ user, userRole }, 3600);
        });
    }
    register(identifier, password, confirmPassword) {
        return __awaiter(this, void 0, void 0, function* () {
            if (password !== confirmPassword)
                throw new AppError(exports.REGISTER_FAILED_INVALID_PASSWORD_CODE, exports.REGISTER_FAILED_INVALID_PASSWORD);
            const _user = yield this.userService.selectByIdentifier(identifier);
            if (_user !== undefined)
                throw new AppError(exports.REGISTER_FAILED_IDENTIFIER_EXISTS_CODE, exports.REGISTER_FAILED_IDENTIFIER_EXISTS);
            const user = yield this.userService.register({
                identifier: identifier,
                password: password,
            });
            if (user === undefined)
                throw new AppError(exports.REGISTER_FAILED_CODE, exports.REGISTER_FAILED_MESSAGE);
            return yield this.jwtService.create(user, 3600);
        });
    }
    validateToken(token) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.jwtService.validate(token);
        });
    }
    refreshToken(token, expired) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.jwtService.refresh(token, expired);
        });
    }
}
exports.User = User;
