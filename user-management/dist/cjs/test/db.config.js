"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbMaxUses = exports.dbConnectionTimeout = exports.dbIdleTimeout = exports.dbPoolMax = exports.dbPoolMin = exports.dbPass = exports.dbUser = exports.dbPort = exports.dbDatabase = exports.dbhost = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.dbhost = process.env.DB_HOST === undefined ? "localhost" : process.env.DB_HOST;
exports.dbDatabase = process.env.DB_DATABASE === undefined ? "postgres" : process.env.DB_DATABASE;
exports.dbPort = process.env.DB_PORT === undefined ? 8000 : parseInt(process.env.DB_PORT, 10);
exports.dbUser = process.env.DB_USER === undefined ? "root" : process.env.DB_USER;
exports.dbPass = process.env.DB_PASS === undefined ? "pass" : process.env.DB_PASS;
exports.dbPoolMin = process.env.DB_POOL_MIN === undefined
    ? 1
    : parseInt(process.env.DB_POOL_MIN, 10);
exports.dbPoolMax = process.env.DB_POOL_MAX === undefined
    ? 1
    : parseInt(process.env.DB_POOL_MAX, 10);
exports.dbIdleTimeout = process.env.DB_IDLE_TIMEOUT === undefined
    ? 1000
    : parseInt(process.env.DB_IDLE_TIMEOUT, 10);
exports.dbConnectionTimeout = process.env.DB_CONNECTION_TIMEOUT === undefined
    ? 1000
    : parseInt(process.env.DB_CONNECTION_TIMEOUT, 10);
exports.dbMaxUses = process.env.DB_MAX_USES === undefined
    ? 7500
    : parseInt(process.env.DB_MAX_USES, 10);
