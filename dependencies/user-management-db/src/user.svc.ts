import { Pool } from "pg";
import { IUser, IUserService } from "user-management/src/interfaces";

export class UserService implements IUserService {
  tblName: string = "tbl_mst_user";
  deleteAllRecordsQuery: string = `DELETE FROM ${this.tblName}`;
  selectByIdentifierQuery: string = `SELECT * FROM ${this.tblName} WHERE identifier=$1`;
  insertUser: string = `INSERT INTO ${this.tblName} (identifier, password) VALUES ($1, $2) RETURNING *`;
  pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  async selectByIdentifier(identifier: string): Promise<IUser | undefined> {
    const client = await this.pool.connect();
    try {
      const dbResult = await client.query(this.selectByIdentifierQuery, [
        identifier,
      ]);
      if (dbResult.rows.length === 0) return undefined;
      return {
        id: dbResult.rows[0].user_id,
        identifier: dbResult.rows[0].identifier,
        password: dbResult.rows[0].password,
      };
    } catch (error) {
      console.error(error);
      if (error instanceof Error)
        throw new Error(`Error in retrieving user: ${error.message}`);
    } finally {
      client.release();
    }
  }
  async truncate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(this.deleteAllRecordsQuery, []);
    } catch (error: any) {
      console.error(error);
      throw new Error(`Error in creating todo: ${error.message}`);
    } finally {
      client.release();
    }
  }
  async register(user: IUser): Promise<IUser | undefined> {
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
    } catch (error: any) {
      console.error(error);
      throw new Error(`Error in creating user: ${error.message}`);
    } finally {
      client.release();
    }
  }
  async login(user: IUser): Promise<IUser | undefined> {
    const client = await this.pool.connect();
    try {
      const dbResult = await client.query(this.selectByIdentifierQuery, [
        user.identifier,
      ]);
      if (dbResult.rows.length === 0) return undefined;
      return {
        id: dbResult.rows[0].user_id,
        identifier: dbResult.rows[0].identifier,
        password: dbResult.rows[0].password,
      };
    } catch (error: any) {
      console.error(error);
      throw new Error(`Error in retrieving user: ${error.message}`);
    } finally {
      client.release();
    }
  }
}
