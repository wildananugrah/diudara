import { IUser, IUserService } from "interfaces";
export declare class UserServiceMock implements IUserService {
    selectByEmail(email: string): Promise<IUser | undefined>;
    register(user: IUser): Promise<IUser | undefined>;
    login(user: IUser): Promise<IUser | undefined>;
    truncate(): Promise<void>;
}
