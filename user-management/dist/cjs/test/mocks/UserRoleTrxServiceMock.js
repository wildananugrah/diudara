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
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserRoleTrxServiceMock = void 0;
class UserRoleTrxServiceMock {
    truncate() {
        throw new Error("Method not implemented.");
    }
    insert(userRole) {
        throw new Error("Method not implemented.");
    }
    list(userId) {
        return __awaiter(this, void 0, void 0, function* () {
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
        });
    }
    delete(id) {
        throw new Error("Method not implemented.");
    }
}
exports.UserRoleTrxServiceMock = UserRoleTrxServiceMock;
