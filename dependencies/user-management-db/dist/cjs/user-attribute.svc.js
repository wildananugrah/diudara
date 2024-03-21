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
exports.UserAttributeService = void 0;
class UserAttributeService {
    constructor(pool) {
        this.tblName = "tbl_mst_user_attribute";
        this.deleteAllRecordsQuery = `
  DELETE FROM ${this.tblName}`;
        this.insertQuery = `
  INSERT INTO ${this.tblName}(user_id, app_name, attribute_name) 
  VALUES($1, $2, $3) RETURNING *`;
        this.selectAllRecordsQuery = `
  SELECT 
  user_attribute_id, user_id, app_name, attribute_name 
  FROM ${this.tblName} WHERE user_id = $1`;
        this.selectByIdRecordsQuery = `
  SELECT 
  user_attribute_id, user_id, app_name, attribute_name 
  FROM ${this.tblName} WHERE user_attribute_id = $1`;
        this.updateQuery = `
  UPDATE ${this.tblName} 
  SET app_name = $1, attribute_name = $2 
  WHERE user_attribute_id = $3 RETURNING *`;
        this.deleteByIdRecordsQuery = `
  DELETE FROM ${this.tblName} 
  WHERE user_attribute_id = $1 RETURNING *`;
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
    insert(roleAttribute) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                const dbResult = yield client.query(this.insertQuery, [
                    roleAttribute.userId,
                    roleAttribute.appName,
                    roleAttribute.attributeName,
                ]);
                return {
                    id: dbResult.rows[0].user_attribute_id,
                    userId: dbResult.rows[0].user_id,
                    appName: dbResult.rows[0].app_name,
                    attributeName: dbResult.rows[0].attribute_name,
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
                const dbResult = yield client.query(this.selectAllRecordsQuery, [userId]);
                if (dbResult.rows.length <= 0)
                    return undefined;
                return dbResult.rows.map((row) => ({
                    id: row.user_attribute_id,
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
    detail(id) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                const dbResult = yield client.query(this.selectByIdRecordsQuery, [id]);
                if (dbResult.rows.length === 0)
                    return undefined;
                return {
                    id: dbResult.rows[0].user_attribute_id,
                    userId: dbResult.rows[0].user_id,
                    appName: dbResult.rows[0].app_name,
                    attributeName: dbResult.rows[0].attribute_name,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in retrieving user attribute detail: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
    update(roleAttribute, id) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                const dbResult = yield client.query(this.updateQuery, [
                    roleAttribute.appName,
                    roleAttribute.attributeName,
                    id,
                ]);
                if (dbResult.rows.length === 0)
                    return undefined;
                return {
                    id: dbResult.rows[0].user_attribute_id,
                    userId: dbResult.rows[0].user_id,
                    appName: dbResult.rows[0].app_name,
                    attributeName: dbResult.rows[0].attribute_name,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in updating user attribute: ${error.message}`);
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
                const dbResult = yield client.query(this.deleteByIdRecordsQuery, [id]);
                if (dbResult.rows.length === 0)
                    return undefined;
                return {
                    id: dbResult.rows[0].user_attribute_id,
                    userId: dbResult.rows[0].user_id,
                    appName: dbResult.rows[0].app_name,
                    attributeName: dbResult.rows[0].attribute_name,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in deleting user attribute: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
}
exports.UserAttributeService = UserAttributeService;
