import fs from "fs";
import jwt from "jsonwebtoken";
import { IJWTService } from "user-management/src/interfaces";

export class JWTService implements IJWTService {
  privateKey: string | undefined;
  certificate: string | undefined;

  constructor({
    privateKey,
    certificate,
  }: {
    privateKey: string;
    certificate: string;
  }) {
    this.privateKey = privateKey;
    this.certificate = certificate;
  }

  async create(data: any, expired: number): Promise<any> {
    if (this.privateKey === undefined) return;
    let pKey = fs.readFileSync(this.privateKey);
    let token = jwt.sign(data, pKey, {
      algorithm: "RS256",
      expiresIn: expired,
    });
    return { token, expired };
  }
  async refresh(token: string, expired: number): Promise<any> {
    const data = await this.validate(token);
    delete data.iat;
    delete data.exp;
    return await this.create(data, expired);
  }
  async validate(token: string): Promise<any> {
    if (this.certificate === undefined) return;
    var cert = fs.readFileSync(this.certificate);
    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        cert,
        { algorithms: ["RS256"] },
        (err, decoded: any) => {
          if (err) reject(err);
          else {
            delete decoded.iat;
            delete decoded.exp;
            resolve(decoded);
          }
        }
      );
    });
  }
}
