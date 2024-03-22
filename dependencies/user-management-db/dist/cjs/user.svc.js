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
exports.UserService = void 0;
class UserService {
    constructor(pool) {
        this.tblName = "tbl_mst_user";
        this.deleteAllRecordsQuery = `DELETE FROM ${this.tblName}`;
        this.selectByIdentifierQuery = `SELECT * FROM ${this.tblName} WHERE identifier=$1`;
        this.insertUser = `INSERT INTO ${this.tblName} (identifier, password) VALUES ($1, $2) RETURNING *`;
        this.pool = pool;
    }
    selectByIdentifier(identifier) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                const dbResult = yield client.query(this.selectByIdentifierQuery, [
                    identifier,
                ]);
                if (dbResult.rows.length === 0)
                    return undefined;
                return {
                    id: dbResult.rows[0].user_id,
                    identifier: dbResult.rows[0].identifier,
                    password: dbResult.rows[0].password,
                };
            }
            catch (error) {
                console.error(error);
                if (error instanceof Error)
                    throw new Error(`Error in retrieving user: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
    truncate() {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                yield client.query(this.deleteAllRecordsQuery, []);
            }
            catch (error) {
                console.error(error);
                throw new Error(`Error in creating todo: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
    register(user) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                const dbResult = yield client.query(this.insertUser, [
                    user.identifier,
                    user.password,
                ]);
                return {
                    id: dbResult.rows[0].user_id,
                    identifier: dbResult.rows[0].identifier,
                    password: dbResult.rows[0].password,
                };
            }
            catch (error) {
                console.error(error);
                throw new Error(`Error in creating user: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
    login(user) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = yield this.pool.connect();
            try {
                const dbResult = yield client.query(this.selectByIdentifierQuery, [
                    user.identifier,
                ]);
                if (dbResult.rows.length === 0)
                    return undefined;
                return {
                    id: dbResult.rows[0].user_id,
                    identifier: dbResult.rows[0].identifier,
                    password: dbResult.rows[0].password,
                };
            }
            catch (error) {
                console.error(error);
                throw new Error(`Error in retrieving user: ${error.message}`);
            }
            finally {
                client.release();
            }
        });
    }
}
exports.UserService = UserService;
