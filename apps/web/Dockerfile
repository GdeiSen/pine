FROM node:22-alpine AS base

RUN corepack enable

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY . .

RUN pnpm --filter @web-radio/shared build
RUN pnpm --filter @web-radio/web build

FROM base AS runtime

ENV NODE_ENV=production

WORKDIR /app
COPY --from=build /app /app

WORKDIR /app/apps/web

EXPOSE 3000

CMD ["pnpm", "start", "-H", "0.0.0.0", "-p", "3000"]
