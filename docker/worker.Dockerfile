# Build context is the monorepo root (see docker-compose.yml).
FROM node:20-alpine AS builder
WORKDIR /repo
COPY package.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN npm install
COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN npm run build -w packages/shared
RUN npm run build -w apps/worker

FROM node:20-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=builder /repo/package.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/shared/dist ./packages/shared/dist
COPY --from=builder /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /repo/apps/worker/dist ./apps/worker/dist
COPY --from=builder /repo/apps/worker/package.json ./apps/worker/package.json
WORKDIR /repo/apps/worker
CMD ["node", "dist/index.js"]
