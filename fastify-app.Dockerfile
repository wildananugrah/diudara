# FROM oven/bun
FROM node:18-alpine

WORKDIR /app
COPY ./ .

WORKDIR /app/io/fastify-app
RUN npm install
HEALTHCHECK --interval=5m --start-period=5s CMD curl -f http://localhost:4000/_/healthcheck
EXPOSE 4000

CMD ["npm", "run" ,"dev"]