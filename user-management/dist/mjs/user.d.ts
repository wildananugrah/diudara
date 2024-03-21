import { IJWTService, IToken, IUser, IUserLogic, IUserRoleTrxService, IUserService } from "interfaces";
export declare const INVALID_EMAIL_CODE: string;
export declare const INVALID_EMAIL_MESSAGE: string;
export declare const INVALID_PASSWORD_CODE: string;
export declare const INVALID_PASSWORD_MESSAGE: string;
export declare const REGISTER_FAILED_EMAIL_EXISTS_CODE: string;
export declare const REGISTER_FAILED_EMAIL_EXISTS: string;
export declare const REGISTER_FAILED_CODE: string;
export declare const REGISTER_FAILED_MESSAGE: string;
export declare const REGISTER_FAILED_INVALID_PASSWORD_CODE: string;
export declare const REGISTER_FAILED_INVALID_PASSWORD: string;
export declare class AppError extends Error {
    message: string;
    code: string;
    constructor(code: string, message: string);
}
export declare class User implements IUserLogic {
    userService: IUserService;
    jwtService: IJWTService;
    userRoleTrxService: IUserRoleTrxService;
    constructor(userService: IUserService, userRoleTrxService: IUserRoleTrxService, jwtService: IJWTService);
    login(email: string, password: string): Promise<IToken | undefined>;
    register(email: string, password: string, confirmPassword: string): Promise<IToken | undefined>;
    validateToken(token: string): Promise<IUser | undefined>;
    refreshToken(token: string, expired: number): Promise<IToken | undefined>;
}
