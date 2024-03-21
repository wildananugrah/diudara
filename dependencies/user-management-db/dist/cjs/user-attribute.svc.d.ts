import { Pool } from "pg";
import { IUserAttribute, IUserAttributeService } from "user-management/src/interfaces";
export declare class UserAttributeService implements IUserAttributeService {
    tblName: string;
    deleteAllRecordsQuery: string;
    insertQuery: string;
    selectAllRecordsQuery: string;
    selectByIdRecordsQuery: string;
    updateQuery: string;
    deleteByIdRecordsQuery: string;
    pool: Pool;
    constructor(pool: Pool);
    truncate(): Promise<void>;
    insert(roleAttribute: IUserAttribute): Promise<IUserAttribute | undefined>;
    list(userId: string): Promise<IUserAttribute[] | undefined>;
    detail(id: string): Promise<IUserAttribute | undefined>;
    update(roleAttribute: IUserAttribute, id: string): Promise<IUserAttribute | undefined>;
    delete(id: string): Promise<IUserAttribute | undefined>;
}
