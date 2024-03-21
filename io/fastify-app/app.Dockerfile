# FROM oven/bun
FROM node:18-alpine

WORKDIR /app
COPY ./ .
RUN npm install

HEALTHCHECK --interval=5m --start-period=5s CMD curl -f http://localhost:${APP_PORT}/_/healthcheck

EXPOSE ${APP_PORT}

CMD ["npm", "run" ,"dev"]