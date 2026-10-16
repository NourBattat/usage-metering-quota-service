FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY tsconfig.client.json ./
COPY src ./src
COPY client ./client
RUN npm run build

FROM node:22-alpine AS demo-bootstrap
WORKDIR /app
COPY scripts/demo-bootstrap.mjs ./scripts/demo-bootstrap.mjs
CMD ["node", "scripts/demo-bootstrap.mjs"]

FROM node:22-alpine AS example-client
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist-client ./dist-client
USER node
ENTRYPOINT ["node", "/app/dist-client/cli.js"]

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY migrations ./migrations

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
