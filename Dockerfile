FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY server ./server
COPY web ./web
COPY data ./data
COPY tsconfig.json ./

USER node
ENV NODE_ENV=production PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/ || exit 1

CMD ["./node_modules/.bin/tsx", "server/index.ts"]
