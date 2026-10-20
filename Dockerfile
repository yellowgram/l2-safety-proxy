FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
# 0.0.0.0 is required inside the container so a published port can reach the
# process. On the host, publish 127.0.0.1:8545:8545 (see docker-compose.yml).
# The process logs a warning whenever it binds a wildcard address.
ENV NODE_ENV=production \
    L2SG_HOST=0.0.0.0 \
    L2SG_PORT=8545 \
    GUARD_MODE=strict \
    L2SG_STORE=file:/state/l2-send-guard-state.jsonl \
    L2SG_CHAINS=arb-sepolia,op-sepolia,base-sepolia \
    L2SG_DEFAULT_CHAIN=arb-sepolia
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm install --no-save --omit=dev pg@^8.11.0
COPY --from=build /app/dist ./dist
RUN mkdir /state && chown node /state
EXPOSE 8545
USER node
CMD ["node", "dist/index.js"]
