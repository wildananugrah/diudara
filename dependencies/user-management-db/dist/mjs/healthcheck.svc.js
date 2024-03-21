export class HealthCheck {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async test() {
        const client = await this.pool.connect();
        try {
            await client.query("SELECT 1 as healtcheck");
            return true;
        }
        catch (error) {
            console.error(error);
            return false;
        }
        finally {
            client.release();
        }
    }
}
