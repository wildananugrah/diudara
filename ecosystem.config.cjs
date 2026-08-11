// pm2 process definitions for the diudara-api and diudara-worker deploys.
//
// Both point at a run.sh wrapper (`exec bun run <entry>`) instead of the .ts entry
// file directly. pm2's native Bun integration require()s the entry file in-process,
// which breaks apps/api/src/server.ts's `export default { port, fetch }` auto-serve
// and apps/worker/src/main.ts's top-level await ("require() async module ...
// unsupported"). Going through a real `bun run` process sidesteps that wrapper.
module.exports = {
  apps: [
    {
      name: "diudara-api",
      script: "./run.sh",
      cwd: __dirname + "/apps/api",
      interpreter: "none",
    },
    {
      name: "diudara-worker",
      script: "./run.sh",
      cwd: __dirname + "/apps/worker",
      interpreter: "none",
    },
  ],
};
