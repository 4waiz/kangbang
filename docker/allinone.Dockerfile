# ---------------------------------------------------------------------------
# KANG BANG - single container: game server + client bundle.
#
# The two-container split in docker-compose.yml is the better shape for a real
# deployment (nginx is a better static server than Node, and the two scale
# independently). This image exists for the platforms that give you exactly one
# container and one port - Fly.io, Railway, Render, Cloud Run - where a second
# service is more trouble than nginx is worth.
#
# The server serves the client itself when SERVE_CLIENT=true, with an SPA
# fallback for deep links, long cache headers on fingerprinted assets, and the
# path confined to the bundle root.
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
COPY packages/server packages/server
COPY packages/client packages/client

# Blank VITE_SERVER_URL: the client derives its API and socket endpoints from
# window.location, which is correct when one process serves both.
ARG VITE_BUILD_LABEL=container
ENV VITE_SERVER_URL="" \
    VITE_BUILD_LABEL=$VITE_BUILD_LABEL

RUN npm run typecheck \
 && npm run build

# Runtime-only manifest: the workspace one declares @kang/shared, which esbuild
# has already inlined and which no registry has.
RUN node -e "\
const p = require('/app/packages/server/package.json'); \
const deps = Object.fromEntries(Object.entries(p.dependencies || {}).filter(([n]) => !n.startsWith('@kang/'))); \
require('fs').writeFileSync('/app/runtime-package.json', JSON.stringify({ \
  name: 'kang-bang', version: p.version, private: true, type: 'module', \
  dependencies: deps \
}, null, 2));"


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/runtime-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && rm -f package-lock.json

COPY --from=build /app/packages/server/dist ./dist
COPY --from=build /app/packages/client/dist ./client

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=8080 \
    HOST=0.0.0.0 \
    SERVE_CLIENT=true \
    CLIENT_DIST=/app/client \
    SQLITE_PATH=/app/data/kangbang.db

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.mjs"]
