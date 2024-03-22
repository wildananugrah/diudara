export const INVALID_IDENTIFIER_CODE = "UM404";
export const INVALID_IDENTIFIER_MESSAGE = "Identifier is invalid!";
export const INVALID_PASSWORD_CODE = "UM400";
export const INVALID_PASSWORD_MESSAGE = "Password is invalid!";
export const REGISTER_FAILED_IDENTIFIER_EXISTS_CODE = "UM400";
export const REGISTER_FAILED_IDENTIFIER_EXISTS = "Identifier has been registered!";
export const REGISTER_FAILED_CODE = "UM400";
export const REGISTER_FAILED_MESSAGE = "System can not register the user!";
export const REGISTER_FAILED_INVALID_PASSWORD_CODE = "UM400";
export const REGISTER_FAILED_INVALID_PASSWORD = "Password and Confirm Password are not matched!";
export class AppError extends Error {
    message;
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.message = message;
        Object.setPrototypeOf(this, AppError.prototype);
    }
}
export class User {
    userService;
    jwtService;
    userRoleTrxService;
    constructor(userService, userRoleTrxService, jwtService) {
        this.userService = userService;
        this.jwtService = jwtService;
        this.userRoleTrxService = userRoleTrxService;
    }
    async login(identifier, password) {
        const user = await this.userService.selectByIdentifier(identifier);
        if (user === undefined || user.id === undefined)
            throw new AppError(INVALID_IDENTIFIER_CODE, INVALID_IDENTIFIER_MESSAGE);
        if (user.password !== password)
            throw new AppError(INVALID_PASSWORD_CODE, INVALID_PASSWORD_MESSAGE);
        const userRole = await this.userRoleTrxService.list(user.id);
        return await this.jwtService.create({ user, userRole }, 3600);
    }
    async register(identifier, password, confirmPassword) {
        if (password !== confirmPassword)
            throw new AppError(REGISTER_FAILED_INVALID_PASSWORD_CODE, REGISTER_FAILED_INVALID_PASSWORD);
        const _user = await this.userService.selectByIdentifier(identifier);
        if (_user !== undefined)
            throw new AppError(REGISTER_FAILED_IDENTIFIER_EXISTS_CODE, REGISTER_FAILED_IDENTIFIER_EXISTS);
        const user = await this.userService.register({
            identifier: identifier,
            password: password,
        });
        if (user === undefined)
            throw new AppError(REGISTER_FAILED_CODE, REGISTER_FAILED_MESSAGE);
        return await this.jwtService.create(user, 3600);
    }
    async validateToken(token) {
        return await this.jwtService.validate(token);
    }
    async refreshToken(token, expired) {
        return await this.jwtService.refresh(token, expired);
    }
}
