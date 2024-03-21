import { Pool } from "pg";
import { IUser, IUserService } from "user-management/src/interfaces";

export class UserService implements IUserService {
  tblName: string = "tbl_mst_user";
  deleteAllRecordsQuery: string = `DELETE FROM ${this.tblName}`;
  selectByEmailQuery: string = `SELECT * FROM ${this.tblName} WHERE email=$1`;
  insertUser: string = `INSERT INTO ${this.tblName} (email, password) VALUES ($1, $2) RETURNING *`;
  pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  async selectByEmail(email: string): Promise<IUser | undefined> {
    const client = await this.pool.connect();
    try {
      const dbResult = await client.query(this.selectByEmailQuery, [email]);
      if (dbResult.rows.length === 0) return undefined;
      return {
        id: dbResult.rows[0].user_id,
        email: dbResult.rows[0].email,
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
        user.email,
        user.password,
      ]);
      return {
        id: dbResult.rows[0].user_id,
        email: dbResult.rows[0].email,
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
      const dbResult = await client.query(this.selectByEmailQuery, [
        user.email,
      ]);
      if (dbResult.rows.length === 0) return undefined;
      return {
        id: dbResult.rows[0].user_id,
        email: dbResult.rows[0].email,
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
