FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/config ./packages/config
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm prisma:generate && pnpm --filter @skrivdet/contracts build && pnpm --filter @skrivdet/api build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg && corepack enable
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/prisma ./prisma
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
