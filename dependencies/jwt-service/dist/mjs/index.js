import fs from "fs";
import jwt from "jsonwebtoken";
export class JWTService {
    privateKey;
    certificate;
    constructor({ privateKey, certificate, }) {
        this.privateKey = privateKey;
        this.certificate = certificate;
    }
    async create(data, expired) {
        if (this.privateKey === undefined)
            return;
        let pKey = fs.readFileSync(this.privateKey);
        let token = jwt.sign(data, pKey, {
            algorithm: "RS256",
            expiresIn: expired,
        });
        return { token, expired };
    }
    async refresh(token, expired) {
        const data = await this.validate(token);
        delete data.iat;
        delete data.exp;
        return await this.create(data, expired);
    }
    async validate(token) {
        if (this.certificate === undefined)
            return;
        var cert = fs.readFileSync(this.certificate);
        return new Promise((resolve, reject) => {
            jwt.verify(token, cert, { algorithms: ["RS256"] }, (err, decoded) => {
                if (err)
                    reject(err);
                else {
                    delete decoded.iat;
                    delete decoded.exp;
                    resolve(decoded);
                }
            });
        });
    }
}
