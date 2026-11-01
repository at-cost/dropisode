# syntax=docker/dockerfile:1
# Dropisode hosted: API, studio UI, public site and job worker in one image.
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/money/package.json packages/money/
COPY packages/studio/package.json packages/studio/
COPY apps/hosted/package.json apps/hosted/
COPY apps/local/package.json apps/local/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @reel/studio build && pnpm --filter @reel/hosted build

FROM node:22-alpine
# ffmpeg with libass (burned-in subtitles and on-screen text), and fonts for it to draw with:
# with no fonts libass draws nothing, silently. pg client tools for backups and the restore drill.
RUN apk add --no-cache ffmpeg postgresql16-client tini fontconfig font-dejavu font-liberation
WORKDIR /app
COPY --from=build /src/apps/hosted/dist ./dist
COPY --from=build /src/apps/hosted/config ./config
COPY --from=build /src/packages/studio/dist/web ./web
COPY --from=build /src/apps/hosted/demo ./demo
RUN mkdir -p /data/media && chown -R node:node /data
ENV NODE_ENV=production PORT=3200 WEB_DIST_DIR=./web STORAGE_LOCAL_DIR=/data/media REEL_DEMO_DIR=/app/demo
USER node
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:3200/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
