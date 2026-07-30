# ---------------------------------------------------------------------------
# KANG BANG - authoritative game server
#
# Two stages: a build stage with the full toolchain, and a runtime stage with
# nothing but Node and one bundled .mjs file. esbuild inlines @kang/shared, so
# the runtime image needs no node_modules at all except `ws`.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build
WORKDIR /app

# Copy only the manifests first so `npm ci` is cached until a dependency
# actually changes.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --workspaces --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server

RUN npm run typecheck -w @kang/shared \
 && npm run typecheck -w @kang/server \
 && npm run build -w @kang/server

# Derive a runtime-only manifest.
#
# The workspace manifest cannot be used directly: it declares `@kang/shared`,
# which esbuild has already inlined into the bundle and which does not exist on
# any registry, so `npm install` in the runtime stage would fail on a 404.
# Deriving it here rather than hardcoding a manifest keeps the `ws` version in
# lockstep with the workspace instead of silently drifting.
RUN node -e "\
const p = require('/app/packages/server/package.json'); \
const deps = Object.fromEntries(Object.entries(p.dependencies || {}).filter(([n]) => !n.startsWith('@kang/'))); \
require('fs').writeFileSync('/app/runtime-package.json', JSON.stringify({ \
  name: 'kang-bang-server', version: p.version, private: true, type: 'module', \
  dependencies: deps \
}, null, 2)); \
console.log('runtime deps:', Object.keys(deps).join(', ') || '(none)');"


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `ws` is the only runtime dependency; node:sqlite is built into Node itself.
COPY --from=build /app/runtime-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && rm -f package-lock.json

COPY --from=build /app/packages/server/dist ./dist

# SQLite lives on a volume so progression survives a container rebuild.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=2567 \
    HOST=0.0.0.0 \
    SQLITE_PATH=/app/data/kangbang.db

EXPOSE 2567

# The server answers /api/health with the room count, so an unhealthy process is
# one that has stopped simulating - not merely one that still holds the port.
HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.mjs"]
