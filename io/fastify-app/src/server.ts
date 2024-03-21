import path from "path";
import { appEnv, appHost, appPort } from "./configs/common.config";

import fastify from "fastify";
const app = fastify({ logger: appEnv === "development" ? true : false });

// register cors plugin
import cors from "@fastify/cors";
app.register(cors);
// TODO list url & method yg di allow

// autoload all custom plugins
import autoLoad from "@fastify/autoload";
app.register(autoLoad, {
  dir: path.join(__dirname, "plugins"),
});

// autoload all routes
app.register(autoLoad, {
  dir: path.join(__dirname, "routes"),
});

app.listen({ host: appHost, port: appPort }, (err: any, _: any) => {
  if (err) {
    console.error(err);
  }
});
