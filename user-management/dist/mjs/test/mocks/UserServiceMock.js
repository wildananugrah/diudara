export class UserServiceMock {
    async selectByEmail(email) {
        if (email === "wildan@gmail.com")
            return undefined;
        return {
            id: "1234567890123456",
            email: "wildananugrah@gmail.com",
            password: "p@ssw0rd",
        };
    }
    async register(user) {
        return {
            id: "1234567890123456",
            email: "wildananugrah@gmail.com",
            password: "p@ssw0rd",
        };
    }
    async login(user) {
        if (user.email === "wildan@mail.com")
            return undefined;
        console.log(user);
        return {
            id: "1234567890123456",
            email: "wildananugrah@gmail.com",
            password: "p@ssw0rd",
        };
    }
    truncate() {
        throw new Error("Method not implemented.");
    }
}
