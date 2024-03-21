import { Pool } from "pg";
import { IUserAttribute, IUserRoleTrx, IUserRoleTrxService } from "user-management/src/interfaces";
export declare class UserRoleTrxService implements IUserRoleTrxService {
    tblName: string;
    deleteAllRecordsQuery: string;
    insertIntoQuery: string;
    selectUserAttribute: string;
    deleteQuery: string;
    pool: Pool;
    constructor(pool: Pool);
    truncate(): Promise<void>;
    insert(userRole: IUserRoleTrx): Promise<IUserRoleTrx | undefined>;
    list(userId: string): Promise<IUserAttribute[] | undefined>;
    delete(id: string): Promise<void>;
}
