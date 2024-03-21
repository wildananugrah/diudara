import { HealthCheck } from "user-management-db/healthcheck";

const routes = async (app: any, options: any) => {
  app.route({
    method: "GET",
    url: "/_/healthcheck",
    handler: async (req: any, res: any) => {
      const db = await new HealthCheck(app.dbPool).test();
      return res.status(200).send({ app: true, db });
    },
  });
};

export default routes;
