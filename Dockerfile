# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --strict-ssl=true; else npm ci; fi
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 LOCAL_DATABASE_PATH=/data/paper.sqlite
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/backend ./backend
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/server.mjs /app/package.json ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://localhost:3000/api/paper/live',{headers:{Authorization:'Basic '+Buffer.from(process.env.AUTH_USER+':'+process.env.AUTH_PASSWORD).toString('base64')}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
