# Build context is the monorepo root (see docker-compose.yml).
FROM node:20-alpine AS builder
WORKDIR /repo
COPY package.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm install
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w packages/shared
RUN npm run build -w apps/api

FROM node:20-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=builder /repo/package.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/shared/dist ./packages/shared/dist
COPY --from=builder /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /repo/apps/api/dist ./apps/api/dist
COPY --from=builder /repo/apps/api/package.json ./apps/api/package.json
COPY --from=builder /repo/apps/api/src/db/migrations ./apps/api/dist/db/migrations
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["node", "dist/index.js"]
