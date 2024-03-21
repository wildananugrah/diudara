import { Pool } from "pg";
export declare class HealthCheck {
    pool: Pool;
    constructor(pool: Pool);
    test(): Promise<boolean>;
}
