import { Pool } from "pg";
import { IUser, IUserService } from "user-management/src/interfaces";
export declare class UserService implements IUserService {
    tblName: string;
    deleteAllRecordsQuery: string;
    selectByEmailQuery: string;
    insertUser: string;
    pool: Pool;
    constructor(pool: Pool);
    selectByEmail(email: string): Promise<IUser | undefined>;
    truncate(): Promise<void>;
    register(user: IUser): Promise<IUser | undefined>;
    login(user: IUser): Promise<IUser | undefined>;
}
