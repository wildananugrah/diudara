import { JWTService } from "jwt-service";
import { AppError } from "user-management/user";
import { certificate, privateKey } from "../configs/jwt.config";

const routes = async (app: any, options: any) => {
  app.route({
    method: "PUT",
    url: "/api/token",
    handler: async (req: any, res: any) => {
      try {
        const jwtService = new JWTService({
          privateKey: privateKey,
          certificate: certificate,
        });
        const { token, expired } = req.body;
        return res.status(200).send(await jwtService.refresh(token, expired));
      } catch (error: any) {
        if (error instanceof AppError) {
          return res
            .status(400)
            .send({ code: error.code, message: error.message });
        }
        return res.status(500).send({ code: 500, message: error.message });
      }
    },
  });
};

export default routes;
