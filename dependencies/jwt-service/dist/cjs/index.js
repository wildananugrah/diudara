"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JWTService = void 0;
const fs_1 = __importDefault(require("fs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
class JWTService {
    constructor({ privateKey, certificate, }) {
        this.privateKey = privateKey;
        this.certificate = certificate;
    }
    create(data, expired) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.privateKey === undefined)
                return;
            let pKey = fs_1.default.readFileSync(this.privateKey);
            let token = jsonwebtoken_1.default.sign(data, pKey, {
                algorithm: "RS256",
                expiresIn: expired,
            });
            return { token, expired };
        });
    }
    refresh(token, expired) {
        return __awaiter(this, void 0, void 0, function* () {
            const data = yield this.validate(token);
            delete data.iat;
            delete data.exp;
            return yield this.create(data, expired);
        });
    }
    validate(token) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.certificate === undefined)
                return;
            var cert = fs_1.default.readFileSync(this.certificate);
            return new Promise((resolve, reject) => {
                jsonwebtoken_1.default.verify(token, cert, { algorithms: ["RS256"] }, (err, decoded) => {
                    if (err)
                        reject(err);
                    else {
                        delete decoded.iat;
                        delete decoded.exp;
                        resolve(decoded);
                    }
                });
            });
        });
    }
}
exports.JWTService = JWTService;
