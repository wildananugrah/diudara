import { Pool, PoolClient } from "pg";

export class HealthCheck {
  pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  async test(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT 1 as healtcheck");
      return true;
    } catch (error) {
      console.error(error);
      return false;
    } finally {
      client.release();
    }
  }
}
