# MassCompute coordinator — single container serves the public API + dashboard + worker hub.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/coordinator/package.json apps/coordinator/
COPY apps/web/index.html apps/web/index.html
RUN npm install --workspace @masscompute/protocol --workspace @masscompute/coordinator
COPY packages/protocol/tsconfig.json packages/protocol/tsconfig.json
COPY packages/protocol/tsconfig.base.json* packages/protocol/
COPY tsconfig.base.json ./
COPY packages/protocol/src packages/protocol/src
COPY apps/coordinator/tsconfig.json apps/coordinator/tsconfig.json
COPY apps/coordinator/src apps/coordinator/src
RUN cd packages/protocol && npx tsc -p tsconfig.json
RUN cd apps/coordinator && npm run build

FROM node:22-alpine
WORKDIR /app
ENV PORT=8080 DATA_DIR=/data
VOLUME /data
COPY --from=build /app/apps/coordinator/dist ./dist
COPY --from=build /app/apps/web/index.html ./web/index.html
EXPOSE 8080
CMD ["node", "dist/coordinator.mjs"]
