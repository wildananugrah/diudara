// pm2 process definition for the API. Referenced by scripts/deploy.sh.
module.exports = {
  apps: [
    {
      name: "diudara-api",
      script: "src/main.ts",
      // Absolute path: the pm2 daemon's PATH is whatever it inherited when it
      // was first started, which need not include ~/.bun/bin.
      interpreter: process.env.HOME + "/.bun/bin/bun",
      cwd: __dirname,
      // fork, NOT cluster. Setting `instances` puts pm2 in cluster mode, which
      // goes through node's cluster module and ignores `interpreter` — node then
      // chokes on .ts with ERR_UNKNOWN_FILE_EXTENSION while pm2 still reports
      // the app "online".
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      // PORT and every secret come from backend/.env, which pm2 does not manage
      // and deploy.sh never touches.
      env: { NODE_ENV: "production" },
    },
  ],
};
