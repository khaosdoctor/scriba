# ponytail: single stage, runs TypeScript directly on Node 24 (no build step).
# Build tools stay in the image only for better-sqlite3's native addon.
FROM node:24-bookworm-slim

WORKDIR /app

# better-sqlite3 compiles a native addon at install time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY knexfile.js ./
COPY migrations ./migrations
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.ts"]
