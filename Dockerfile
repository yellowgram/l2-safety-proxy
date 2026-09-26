FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
# 0.0.0.0 is required inside the container so a published port can reach the
# process. On the host, publish 127.0.0.1:8545:8545 (see docker-compose.yml).
# The process logs a warning whenever it binds a wildcard address.
ENV NODE_ENV=production \
    L2SG_HOST=0.0.0.0 \
    L2SG_PORT=8545 \
    GUARD_MODE=open \
    L2SG_CHAINS=arb-sepolia,op-sepolia,base-sepolia \
    L2SG_DEFAULT_CHAIN=arb-sepolia
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8545
USER node
CMD ["node", "dist/index.js"]
