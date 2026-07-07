# ponytail: two stages so the build toolchain never ships in the final image, on Alpine to
# keep it small. No TS build step — tsx runs TypeScript directly; the only thing compiled is
# better-sqlite3's native addon, built here and copied into the runtime stage.

FROM node:24-alpine AS builder
WORKDIR /app
# Toolchain for better-sqlite3's node-gyp build — builder stage only.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
WORKDIR /app
# The compiled addon links libstdc++/libgcc at runtime; ca-certificates for outbound HTTPS
# (Telegram, Groq, Obsidian REST). No compilers in this stage.
RUN apk add --no-cache libstdc++ ca-certificates
COPY --from=builder /app/node_modules ./node_modules
COPY package.json knexfile.js ./
COPY migrations ./migrations
COPY src ./src

ENV NODE_ENV=production
# Build-time commit sha, logged at boot. Placed late so it never busts the npm-install layer.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
