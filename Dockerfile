# ponytail: two stages so the build toolchain never ships in the final image, on Alpine to
# keep it small. No TS build step — tsx runs TypeScript directly; the only thing compiled is
# better-sqlite3's native addon, built here and copied lean into the runtime stage.

FROM node:24-alpine AS builder
WORKDIR /app
# Toolchain for better-sqlite3's node-gyp build — builder stage only.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
# BuildKit cache mount keeps ~/.npm warm across builds so reinstalls don't re-download.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund
# Strip runtime-dead weight before it ever hits a layer:
#  - better-sqlite3 ships 24M of C source + build intermediates; only the compiled .node is
#    needed at runtime.
#  - the agent SDK bundles ripgrep for 5 platforms, but scriba runs it with allowedTools:[]
#    (tools never spawn), so keep only the one platform this image runs on.
RUN cd node_modules/better-sqlite3 \
 && rm -rf deps src build/Release/obj build/Release/obj.target build/Release/.deps \
           build/Release/sqlite3.a build/Release/test_extension.node \
 && cd /app \
 && find node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep -mindepth 1 -maxdepth 1 \
         -type d ! -name x64-linux -exec rm -rf {} +

FROM node:24-alpine
WORKDIR /app
# The compiled addon links libstdc++/libgcc at runtime; ca-certificates for outbound HTTPS
# (Telegram, Groq, Obsidian REST). No compilers in this stage.
RUN apk add --no-cache libstdc++ ca-certificates
COPY --from=builder /app/node_modules ./node_modules
# Everything else is app source (see .dockerignore); one layer, tsx runs it directly.
COPY . .

# Build-time commit sha, logged at boot. ARG + ENV placed last so they never bust the
# node_modules layer; NODE_ENV rides along in the same layer.
ARG GIT_SHA=unknown
ENV NODE_ENV=production GIT_SHA=$GIT_SHA
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
