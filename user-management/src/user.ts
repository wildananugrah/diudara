import {
  IJWTService,
  IToken,
  IUser,
  IUserLogic,
  IUserRoleTrxService,
  IUserService,
} from "interfaces";
export const INVALID_EMAIL_CODE: string = "UM404";
export const INVALID_EMAIL_MESSAGE: string = "email is invalid!";
export const INVALID_PASSWORD_CODE: string = "UM400";
export const INVALID_PASSWORD_MESSAGE: string = "Password is invalid!";
export const REGISTER_FAILED_EMAIL_EXISTS_CODE: string = "UM400";
export const REGISTER_FAILED_EMAIL_EXISTS: string =
  "Email has been registered!";
export const REGISTER_FAILED_CODE: string = "UM400";
export const REGISTER_FAILED_MESSAGE: string =
  "System can not register the user!";
export const REGISTER_FAILED_INVALID_PASSWORD_CODE: string = "UM400";
export const REGISTER_FAILED_INVALID_PASSWORD: string =
  "Password and Confirm Password are not matched!";
export class AppError extends Error {
  message: string;
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.message = message;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}
export class User implements IUserLogic {
  userService: IUserService;
  jwtService: IJWTService;
  userRoleTrxService: IUserRoleTrxService;
  constructor(
    userService: IUserService,
    userRoleTrxService: IUserRoleTrxService,
    jwtService: IJWTService
  ) {
    this.userService = userService;
    this.jwtService = jwtService;
    this.userRoleTrxService = userRoleTrxService;
  }
  async login(email: string, password: string): Promise<IToken | undefined> {
    const user = await this.userService.selectByEmail(email);
    if (user === undefined || user.id === undefined)
      throw new AppError(INVALID_EMAIL_CODE, INVALID_EMAIL_MESSAGE);
    if (user.password !== password)
      throw new AppError(INVALID_PASSWORD_CODE, INVALID_PASSWORD_MESSAGE);
    const userRole = await this.userRoleTrxService.list(user.id);
    return await this.jwtService.create({ user, userRole }, 3600);
  }
  async register(
    email: string,
    password: string,
    confirmPassword: string
  ): Promise<IToken | undefined> {
    if (password !== confirmPassword)
      throw new AppError(
        REGISTER_FAILED_INVALID_PASSWORD_CODE,
        REGISTER_FAILED_INVALID_PASSWORD
      );
    const _user = await this.userService.selectByEmail(email);
    if (_user !== undefined)
      throw new AppError(
        REGISTER_FAILED_EMAIL_EXISTS_CODE,
        REGISTER_FAILED_EMAIL_EXISTS
      );
    const user = await this.userService.register({
      email: email,
      password: password,
    });
    if (user === undefined)
      throw new AppError(REGISTER_FAILED_CODE, REGISTER_FAILED_MESSAGE);
    return await this.jwtService.create(user, 3600);
  }
  async validateToken(token: string): Promise<IUser | undefined> {
    return await this.jwtService.validate(token);
  }
  async refreshToken(
    token: string,
    expired: number
  ): Promise<IToken | undefined> {
    return await this.jwtService.refresh(token, expired);
  }
}
