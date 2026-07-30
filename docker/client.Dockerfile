# ---------------------------------------------------------------------------
# KANG BANG - browser client
#
# Vite produces a static bundle; nginx serves it and reverse-proxies /api and
# /ws to the game server so the browser only ever talks to one origin. That
# means no CORS in production and no separate WebSocket hostname to configure.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --workspaces --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/client packages/client

# Blank VITE_SERVER_URL makes the client derive its endpoints from
# window.location, which is exactly right behind the nginx proxy below.
ARG VITE_BUILD_LABEL=docker
ENV VITE_SERVER_URL="" \
    VITE_BUILD_LABEL=$VITE_BUILD_LABEL

RUN npm run typecheck -w @kang/client \
 && npm run build -w @kang/client


FROM nginx:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/client/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
