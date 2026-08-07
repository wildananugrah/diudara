import { bootstrap } from "./bootstrap";
import { createApp } from "./app";

const deps = bootstrap();
const app = createApp(deps);

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
