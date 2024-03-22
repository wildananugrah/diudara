import { IUser, IUserService } from "interfaces";

export class UserServiceMock implements IUserService {
  async selectByIdentifier(identifier: string): Promise<IUser | undefined> {
    if (identifier === "wildan@gmail.com") return undefined;
    return {
      id: "1234567890123456",
      identifier: "wildananugrah@gmail.com",
      password: "p@ssw0rd",
    };
  }
  async register(user: IUser): Promise<IUser | undefined> {
    return {
      id: "1234567890123456",
      identifier: "wildananugrah@gmail.com",
      password: "p@ssw0rd",
    };
  }
  async login(user: IUser): Promise<IUser | undefined> {
    if (user.identifier === "wildan@mail.com") return undefined;
    console.log(user);
    return {
      id: "1234567890123456",
      identifier: "wildananugrah@gmail.com",
      password: "p@ssw0rd",
    };
  }
  truncate(): Promise<void> {
    throw new Error("Method not implemented.");
  }
}
