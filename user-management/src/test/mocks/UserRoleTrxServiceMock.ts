import { IUserAttribute, IUserRoleTrx, IUserRoleTrxService } from "interfaces";

export class UserRoleTrxServiceMock implements IUserRoleTrxService {
  truncate(): Promise<void> {
    throw new Error("Method not implemented.");
  }
  insert(userRole: IUserRoleTrx): Promise<IUserRoleTrx | undefined> {
    throw new Error("Method not implemented.");
  }
  async list(userId: string): Promise<IUserAttribute[] | undefined> {
    return [
      {
        id: "8e8a4c28-70db-416d-8f2c-1013d5b7dbe6",
        userId: "54817805-d127-4655-adee-ec376f274979",
        appName: "testApp",
        attributeName: ["READ", "WRITE"],
      },
      {
        id: "79ab83ca-46ac-4369-a6fd-4e193f693018",
        userId: "54817805-d127-4655-adee-ec376f274979",
        appName: "testApp1",
        attributeName: ["READ", "WRITE"],
      },
      {
        id: "5aa4665b-bdc1-419e-9d85-563316cefcdb",
        userId: "54817805-d127-4655-adee-ec376f274979",
        appName: "testApp2",
        attributeName: ["READ", "WRITE"],
      },
      {
        id: "429a884c-49d0-4f39-9100-247073054d3f",
        userId: "54817805-d127-4655-adee-ec376f274979",
        appName: "testApp3",
        attributeName: ["READ"],
      },
    ];
  }
  delete(id: string): Promise<void> {
    throw new Error("Method not implemented.");
  }
}
