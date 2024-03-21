import { IUser, IUserService } from "interfaces";

export class UserServiceMock implements IUserService {
  async selectByEmail(email: string): Promise<IUser | undefined> {
    if (email === "wildan@gmail.com") return undefined;
    return {
      id: "1234567890123456",
      email: "wildananugrah@gmail.com",
      password: "p@ssw0rd",
    };
  }
  async register(user: IUser): Promise<IUser | undefined> {
    return {
      id: "1234567890123456",
      email: "wildananugrah@gmail.com",
      password: "p@ssw0rd",
    };
  }
  async login(user: IUser): Promise<IUser | undefined> {
    if (user.email === "wildan@mail.com") return undefined;
    console.log(user);
    return {
      id: "1234567890123456",
      email: "wildananugrah@gmail.com",
      password: "p@ssw0rd",
    };
  }
  truncate(): Promise<void> {
    throw new Error("Method not implemented.");
  }
}
