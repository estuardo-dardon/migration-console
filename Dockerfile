# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    CONSOLE_CONFIG=/config/config.json \
    CONSOLE_HOST=0.0.0.0 \
    CONSOLE_PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Not root: the console only needs to read the migrations and the configuration, and to reach the databases.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- "http://127.0.0.1:${CONSOLE_PORT}/api/health" >/dev/null || exit 1
CMD ["node", "dist/cli.js", "serve"]
