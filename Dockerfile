# syntax=docker/dockerfile:1
FROM node:24.22.0-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM build AS prod-deps
RUN pnpm prune --prod

FROM node:24.22.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY config ./config
USER node
EXPOSE 3000
# A TCP connect is enough: unauthenticated HTTP probes would only add noise to the 401 metrics.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD node -e "require('net').connect(Number(process.env.PORT||3000),'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
CMD ["node", "dist/main.js"]
