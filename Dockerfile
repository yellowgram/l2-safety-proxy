FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    L2SG_HOST=0.0.0.0 \
    L2SG_PORT=8545 \
    L2SG_FAIL_OPEN=true \
    L2SG_CHAINS=arb-sepolia,op-sepolia,base-sepolia \
    L2SG_DEFAULT_CHAIN=arb-sepolia
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8545
USER node
CMD ["node", "dist/index.js"]
