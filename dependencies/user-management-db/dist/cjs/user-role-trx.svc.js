"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserRoleTrxService = void 0;
class UserRoleTrxService {
    constructor(pool) {
        this.tblName = "tbl_trx_user_role";
        this.deleteAllRecordsQuery = `
  delete from tbl_trx_user_role
  `;
        this.insertIntoQuery = `
    insert into tbl_trx_user_role (user_id , role_id)
    values($1, $2) returning *;
  `;
        this.selectUserAttribute = `
    select * from (select 
        tmra.role_attribute_id, 
        tmra.app_name, 
        tmra.attribute_name,
        tmra.created_at,
        tmu.user_id
    from tbl_trx_user_role ttur
    join tbl_mst_role tmr on ttur.role_id = tmr.role_id
    join tbl_mst_role_attribute tmra on tmra.role_id  = tmr.role_id 
    join tbl_mst_user tmu on ttur.user_id = tmu.user_id
    union
    select 
        tmua.user_attribute_id role_attribute_id, 
        tmua.app_name, 
        tmua.attribute_name, 
        tmua.created_at,
        tmu.user_id
    from tbl_mst_user_attribute tmua
    join tbl_mst_user tmu on tmu.user_id = tmua.user_id) as a 
    where a.user_id=$1
    order by a.created_at asc
  `;
        this.deleteQuery = `
  delete from tbl_trx_user_role where role_attribute_id = $1
  `;
        this.pool = pool;
    }
    truncate() {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                yield client.query(this.deleteAllRecordsQuery, []);
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in truncating user attribute: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
    insert(userRole) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                const dbResult = yield client.query(this.insertIntoQuery, [
                    userRole.userId,
                    userRole.roleId,
                ]);
                return {
                    id: dbResult.rows[0].user_role_id,
                    userId: dbResult.rows[0].user_id,
                    roleId: dbResult.rows[0].role_id,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in inserting user attribute: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
    list(userId) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                const dbResult = yield client.query(this.selectUserAttribute, [userId]);
                if (dbResult.rows.length <= 0)
                    return undefined;
                return dbResult.rows.map((row) => ({
                    id: row.role_attribute_id,
                    userId: row.user_id,
                    appName: row.app_name,
                    attributeName: row.attribute_name,
                }));
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in retrieving user attribute: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
    delete(id) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                yield client.query(this.deleteQuery, [id]);
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in truncating user attribute: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
}
exports.UserRoleTrxService = UserRoleTrxService;
