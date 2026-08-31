# Build context is the monorepo root (see docker-compose.yml).
FROM node:20-alpine AS builder
WORKDIR /repo
COPY package.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm install
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w packages/shared
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build -w apps/web

FROM node:20-alpine
WORKDIR /repo/apps/web
ENV NODE_ENV=production
COPY --from=builder /repo/node_modules ../../node_modules
COPY --from=builder /repo/packages/shared ../../packages/shared
COPY --from=builder /repo/apps/web/.next ./.next
COPY --from=builder /repo/apps/web/package.json ./package.json
COPY --from=builder /repo/apps/web/next.config.js ./next.config.js
EXPOSE 3000
CMD ["npm", "run", "start"]
