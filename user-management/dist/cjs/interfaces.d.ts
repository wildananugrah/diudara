export interface IUser {
    id?: string;
    identifier: string;
    password: string;
    attributes?: IRoleAttribute[] | IUserAttribute[];
}
export interface IRole {
    id?: string;
    roleName: string;
}
export interface IRoleAttribute {
    id?: string;
    roleId: string;
    appName: string;
    attributeName: string[];
}
export interface IUserAttribute {
    id?: string;
    userId: string;
    appName: string;
    attributeName: string[];
}
export interface IUserRoleTrx {
    id?: string;
    userId: string;
    roleId: string;
}
export interface IToken {
    token: string;
    expired: number;
}
export interface IJWTService {
    create(data: any, expired: number): Promise<IToken>;
    refresh(token: string, expired: number): Promise<IToken>;
    validate(token: string): Promise<any>;
}
export interface IUserService {
    register(user: IUser): Promise<IUser | undefined>;
    login(user: IUser): Promise<IUser | undefined>;
    selectByIdentifier(identifier: string): Promise<IUser | undefined>;
    truncate(): Promise<void>;
}
export interface IRoleService {
    truncate(): Promise<void>;
    insert(role: IRole): Promise<IRole | undefined>;
    list(): Promise<IRole[] | undefined>;
    detail(id: string): Promise<IRole | undefined>;
    update(role: IRole, id: string): Promise<IRole | undefined>;
    delete(id: string): Promise<IRole | undefined>;
}
export interface IRoleAttributeService {
    truncate(): Promise<void>;
    insert(role: IRoleAttribute): Promise<IRoleAttribute | undefined>;
    list(roleId: string): Promise<IRoleAttribute[] | undefined>;
    detail(id: string): Promise<IRoleAttribute | undefined>;
    update(role: IRoleAttribute, id: string): Promise<IRoleAttribute | undefined>;
    delete(id: string): Promise<IRoleAttribute | undefined>;
}
export interface IUserAttributeService {
    truncate(): Promise<void>;
    insert(userAttribute: IUserAttribute): Promise<IUserAttribute | undefined>;
    list(userId: string): Promise<IUserAttribute[] | undefined>;
    detail(id: string): Promise<IUserAttribute | undefined>;
    update(userAttribute: IUserAttribute, id: string): Promise<IUserAttribute | undefined>;
    delete(userId: string): Promise<IUserAttribute | undefined>;
}
export interface IUserLogic {
    register(identifier: string, password: string, confirmPassword: string): Promise<IToken | undefined>;
    login(identifier: string, password: string): Promise<IToken | undefined>;
    validateToken(token: string): Promise<IUser | undefined>;
    refreshToken(token: string, expired: number): Promise<IToken | undefined>;
}
export interface IUserRoleTrxService {
    truncate(): Promise<void>;
    insert(userRole: IUserRoleTrx): Promise<IUserRoleTrx | undefined>;
    list(userId: string): Promise<IUserAttribute[] | undefined>;
    delete(id: string): Promise<void>;
}
