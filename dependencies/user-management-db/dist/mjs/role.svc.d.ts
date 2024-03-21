import { IRole, IRoleService } from "user-management/src/interfaces";
import { Pool } from "pg";
export declare class RoleService implements IRoleService {
    tblName: string;
    deleteAllRecordsQuery: string;
    insertRoleQuery: string;
    selectAllRecordsQuery: string;
    selectByIdRecordsQuery: string;
    updateRoleQuery: string;
    deleteByIdRecordsQuery: string;
    pool: Pool;
    constructor(pool: Pool);
    truncate(): Promise<void>;
    insert(role: IRole): Promise<IRole | undefined>;
    list(): Promise<IRole[] | undefined>;
    detail(id: string): Promise<IRole | undefined>;
    update(role: IRole, id: string): Promise<IRole | undefined>;
    delete(id: string): Promise<IRole | undefined>;
}
