import dotenv from "dotenv";

dotenv.config();

export const appEnv =
  process.env.APP_ENV === undefined ? "development" : process.env.APP_ENV;
export const appHost =
  process.env.APP_HOST == undefined ? "0.0.0.0" : process.env.APP_HOST;
export const appPort =
  process.env.APP_PORT === undefined
    ? 8000
    : parseInt(process.env.APP_PORT, 10);
