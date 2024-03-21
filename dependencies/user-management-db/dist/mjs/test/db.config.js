import dotenv from "dotenv";
dotenv.config();
export const dbhost = process.env.DB_HOST === undefined ? "localhost" : process.env.DB_HOST;
export const dbDatabase = process.env.DB_DATABASE === undefined ? "postgres" : process.env.DB_DATABASE;
export const dbPort = process.env.DB_PORT === undefined ? 8000 : parseInt(process.env.DB_PORT, 10);
export const dbUser = process.env.DB_USER === undefined ? "root" : process.env.DB_USER;
export const dbPass = process.env.DB_PASS === undefined ? "pass" : process.env.DB_PASS;
export const dbPoolMin = process.env.DB_POOL_MIN === undefined
    ? 1
    : parseInt(process.env.DB_POOL_MIN, 10);
export const dbPoolMax = process.env.DB_POOL_MAX === undefined
    ? 1
    : parseInt(process.env.DB_POOL_MAX, 10);
export const dbIdleTimeout = process.env.DB_IDLE_TIMEOUT === undefined
    ? 1000
    : parseInt(process.env.DB_IDLE_TIMEOUT, 10);
export const dbConnectionTimeout = process.env.DB_CONNECTION_TIMEOUT === undefined
    ? 1000
    : parseInt(process.env.DB_CONNECTION_TIMEOUT, 10);
export const dbMaxUses = process.env.DB_MAX_USES === undefined
    ? 7500
    : parseInt(process.env.DB_MAX_USES, 10);
