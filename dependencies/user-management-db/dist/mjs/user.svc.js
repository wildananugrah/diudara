export class UserService {
    tblName = "tbl_mst_user";
    deleteAllRecordsQuery = `DELETE FROM ${this.tblName}`;
    selectByEmailQuery = `SELECT * FROM ${this.tblName} WHERE email=$1`;
    insertUser = `INSERT INTO ${this.tblName} (email, password) VALUES ($1, $2) RETURNING *`;
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async selectByEmail(email) {
        const client = await this.pool.connect();
        try {
            const dbResult = await client.query(this.selectByEmailQuery, [email]);
            if (dbResult.rows.length === 0)
                return undefined;
            return {
                id: dbResult.rows[0].user_id,
                email: dbResult.rows[0].email,
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
                user.email,
                user.password,
            ]);
            return {
                id: dbResult.rows[0].user_id,
                email: dbResult.rows[0].email,
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
            const dbResult = await client.query(this.selectByEmailQuery, [
                user.email,
            ]);
            if (dbResult.rows.length === 0)
                return undefined;
            return {
                id: dbResult.rows[0].user_id,
                email: dbResult.rows[0].email,
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
