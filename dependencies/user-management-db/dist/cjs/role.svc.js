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
exports.RoleService = void 0;
class RoleService {
    constructor(pool) {
        this.tblName = "tbl_mst_role";
        this.deleteAllRecordsQuery = `DELETE FROM ${this.tblName}`;
        this.insertRoleQuery = `INSERT INTO ${this.tblName}(role_name) VALUES($1) RETURNING *`;
        this.selectAllRecordsQuery = `SELECT role_id, role_name FROM ${this.tblName}`;
        this.selectByIdRecordsQuery = `SELECT role_id, role_name FROM ${this.tblName} WHERE role_id = $1`;
        this.updateRoleQuery = `UPDATE ${this.tblName} SET role_name = $1 WHERE role_id = $2 RETURNING *`;
        this.deleteByIdRecordsQuery = `DELETE FROM ${this.tblName} WHERE role_id = $1 RETURNING *`;
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
                    throw new Error(`Error in truncating role: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
    insert(role) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                const dbResult = yield client.query(this.insertRoleQuery, [
                    role.roleName,
                ]);
                return {
                    id: dbResult.rows[0].role_id,
                    roleName: dbResult.rows[0].role_name,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in inserting role: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
    list() {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                const dbResult = yield client.query(this.selectAllRecordsQuery, []);
                return dbResult.rows.map((row) => ({
                    id: row.role_id,
                    roleName: row.role_name,
                }));
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in retrieving role: ${error.message}`);
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
                    id: dbResult.rows[0].role_id,
                    roleName: dbResult.rows[0].role_name,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in retrieving role detail: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
    update(role, id) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                const dbResult = yield client.query(this.updateRoleQuery, [
                    role.roleName,
                    id,
                ]);
                if (dbResult.rows.length === 0)
                    return undefined;
                return {
                    id: dbResult.rows[0].role_id,
                    roleName: dbResult.rows[0].role_name,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in updating role: ${error.message}`);
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
                    id: dbResult.rows[0].role_id,
                    roleName: dbResult.rows[0].role_name,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in deleting role: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
}
exports.RoleService = RoleService;
