# Multi-stage: compile TS with dev deps, ship only dist/ + prod deps.
#
# The build context is the REPO ROOT, not api/ — the service imports
# @pipeline-radar/shared (the pure trial/drug logic the web app and the agent
# both use), so the image has to see the workspace. Build it with:
#   docker build -f api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first: dependency install then caches independently of source edits.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY api/package.json ./api/package.json
COPY pipeline-radar/package.json ./pipeline-radar/package.json
RUN npm ci --include-workspace-root -w @pipeline-radar/shared -w pipeline-radar-api

COPY shared ./shared
COPY api ./api
RUN npm run build -w @pipeline-radar/shared \
 && npm run build -w pipeline-radar-api \
 && npm prune --omit=dev \
 && mkdir -p api/node_modules shared/node_modules

FROM node:22-alpine
ENV NODE_ENV=production PORT=3001
WORKDIR /app
# npm workspaces does NOT hoist everything: express resolves from
# api/node_modules, not the root. Copying only the root produced an image that
# built fine and then died at startup with "Cannot find module 'express'" -
# invisible to CI, which builds the image but never runs it. The mkdir in the
# build stage guarantees these paths exist even when a workspace has no
# unhoisted deps, so COPY cannot fail.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/api/node_modules ./api/node_modules
COPY --from=build /app/shared/node_modules ./shared/node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/api/package.json ./api/package.json
COPY --from=build /app/api/dist ./api/dist
USER node
EXPOSE 3001
CMD ["node", "api/dist/server.js"]
