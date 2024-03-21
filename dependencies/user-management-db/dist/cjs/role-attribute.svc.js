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
exports.RoleAttributeService = void 0;
class RoleAttributeService {
    constructor(pool) {
        this.tblName = "tbl_mst_role_attribute";
        this.deleteAllRecordsQuery = `DELETE FROM ${this.tblName}`;
        this.insertRoleQuery = `INSERT INTO ${this.tblName}(role_id, app_name, attribute_name) VALUES($1, $2, $3) RETURNING *`;
        this.selectAllRecordsQuery = `SELECT role_id, app_name, attribute_name FROM ${this.tblName} WHERE role_id = $1`;
        this.selectByIdRecordsQuery = `SELECT role_id, app_name, attribute_name FROM ${this.tblName} WHERE role_attribute_id = $1`;
        this.updateRoleQuery = `UPDATE ${this.tblName} SET app_name = $1, attribute_name = $2 WHERE role_attribute_id = $3 RETURNING *`;
        this.deleteByIdRecordsQuery = `DELETE FROM ${this.tblName} WHERE role_attribute_id = $1 RETURNING *`;
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
                    throw new Error(`Error in truncating role attribute: ${error.message}`);
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
                const dbResult = yield client.query(this.insertRoleQuery, [
                    roleAttribute.roleId,
                    roleAttribute.appName,
                    roleAttribute.attributeName,
                ]);
                return {
                    id: dbResult.rows[0].role_attribute_id,
                    roleId: dbResult.rows[0].role_id,
                    appName: dbResult.rows[0].app_name,
                    attributeName: dbResult.rows[0].attribute_name,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in inserting role attribute: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
    list(roleId) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                const dbResult = yield client.query(this.selectAllRecordsQuery, [roleId]);
                if (dbResult.rows.length <= 0)
                    return undefined;
                return dbResult.rows.map((row) => ({
                    id: row.role_attribute_id,
                    roleId: row.role_id,
                    appName: row.app_name,
                    attributeName: row.attribute_name,
                }));
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in retrieving role attribute: ${error.message}`);
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
                    id: dbResult.rows[0].role_attribute_id,
                    roleId: dbResult.rows[0].role_id,
                    appName: dbResult.rows[0].app_name,
                    attributeName: dbResult.rows[0].attribute_name,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in retrieving role attribute detail: ${error.message}`);
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
                const dbResult = yield client.query(this.updateRoleQuery, [
                    roleAttribute.appName,
                    roleAttribute.attributeName,
                    id,
                ]);
                if (dbResult.rows.length === 0)
                    return undefined;
                return {
                    id: dbResult.rows[0].role_attribute_id,
                    roleId: dbResult.rows[0].role_id,
                    appName: dbResult.rows[0].app_name,
                    attributeName: dbResult.rows[0].attribute_name,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in updating role attribute: ${error.message}`);
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
                    id: dbResult.rows[0].role_attribute_id,
                    roleId: dbResult.rows[0].role_id,
                    appName: dbResult.rows[0].app_name,
                    attributeName: dbResult.rows[0].attribute_name,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in deleting role attribute: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
}
exports.RoleAttributeService = RoleAttributeService;
