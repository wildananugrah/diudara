export class UserService {
    tblName = "tbl_mst_user";
    deleteAllRecordsQuery = `DELETE FROM ${this.tblName}`;
    selectByIdentifierQuery = `SELECT * FROM ${this.tblName} WHERE identifier=$1`;
    insertUser = `INSERT INTO ${this.tblName} (identifier, password) VALUES ($1, $2) RETURNING *`;
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async selectByIdentifier(identifier) {
        const client = await this.pool.connect();
        try {
            const dbResult = await client.query(this.selectByIdentifierQuery, [
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
    }
    async truncate() {
        const client = await this.pool.connect();
        try {
            await client.query(this.deleteAllRecordsQuery, []);
        }
        catch (error) {
            console.error(error);
            throw new Error(`Error in creating todo: ${error.message}`);
        }
        finally {
            client.release();
        }
    }
    async register(user) {
        const client = await this.pool.connect();
        try {
            const dbResult = await client.query(this.insertUser, [
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
    }
    async login(user) {
        const client = await this.pool.connect();
        try {
            const dbResult = await client.query(this.selectByIdentifierQuery, [
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
    }
}
