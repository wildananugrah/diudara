import { JWTService } from "../index";
describe("JWT Service", () => {
    const data = {
        username: "wildananugrah",
        password: "p@ssw0rd",
    };
    const expired = 3600;
    let token = "";
    it("should create token", async () => {
        let jwtService = new JWTService({
            privateKey: "./keys/key.key",
            certificate: "./keys/certificate.crt",
        });
        const result = await jwtService.create(data, expired);
        expect(typeof result?.token).toBe("string");
        token = result?.token;
        expect(result?.expired).toBe(expired);
    });
    it("should validate token", async () => {
        let jwtService = new JWTService({
            privateKey: "./keys/key.key",
            certificate: "./keys/certificate.crt",
        });
        const result = await jwtService.validate(token);
        expect(result?.username).toBe(data.username);
        expect(result?.password).toBe(data.password);
    });
    it("should refresh token", async () => {
        let jwtService = new JWTService({
            privateKey: "./keys/key.key",
            certificate: "./keys/certificate.crt",
        });
        const result = await jwtService.refresh(token, expired);
        expect(typeof result?.token).toBe("string");
        token = result?.token;
        expect(result?.expired).toBe(expired);
    });
    it("should validate token again", async () => {
        let jwtService = new JWTService({
            privateKey: "./keys/key.key",
            certificate: "./keys/certificate.crt",
        });
        const result = await jwtService.validate(token);
        expect(result?.username).toBe(data.username);
        expect(result?.password).toBe(data.password);
    });
});
