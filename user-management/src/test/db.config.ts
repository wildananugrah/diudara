import dotenv from "dotenv";

dotenv.config();

export const dbhost: string =
  process.env.DB_HOST === undefined ? "localhost" : process.env.DB_HOST;
export const dbDatabase: string =
  process.env.DB_DATABASE === undefined ? "postgres" : process.env.DB_DATABASE;
export const dbPort: number =
  process.env.DB_PORT === undefined ? 8000 : parseInt(process.env.DB_PORT, 10);
export const dbUser: string =
  process.env.DB_USER === undefined ? "root" : process.env.DB_USER;
export const dbPass: string =
  process.env.DB_PASS === undefined ? "pass" : process.env.DB_PASS;
export const dbPoolMin: number =
  process.env.DB_POOL_MIN === undefined
    ? 1
    : parseInt(process.env.DB_POOL_MIN, 10);
export const dbPoolMax: number =
  process.env.DB_POOL_MAX === undefined
    ? 1
    : parseInt(process.env.DB_POOL_MAX, 10);
export const dbIdleTimeout: number =
  process.env.DB_IDLE_TIMEOUT === undefined
    ? 1000
    : parseInt(process.env.DB_IDLE_TIMEOUT, 10);
export const dbConnectionTimeout: number =
  process.env.DB_CONNECTION_TIMEOUT === undefined
    ? 1000
    : parseInt(process.env.DB_CONNECTION_TIMEOUT, 10);
export const dbMaxUses: number =
  process.env.DB_MAX_USES === undefined
    ? 7500
    : parseInt(process.env.DB_MAX_USES, 10);
