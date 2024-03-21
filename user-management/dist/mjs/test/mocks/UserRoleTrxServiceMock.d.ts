import { IUserAttribute, IUserRoleTrx, IUserRoleTrxService } from "interfaces";
export declare class UserRoleTrxServiceMock implements IUserRoleTrxService {
    truncate(): Promise<void>;
    insert(userRole: IUserRoleTrx): Promise<IUserRoleTrx | undefined>;
    list(userId: string): Promise<IUserAttribute[] | undefined>;
    delete(id: string): Promise<void>;
}
