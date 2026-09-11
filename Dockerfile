# Cutline in a container: the local server and the built web app, one process.
#
#   docker compose up -d        then open http://localhost:5311
#
# Projects, recordings and media live in the mounted ~/Cutline, as ordinary
# files, exactly as without Docker. Two things only work outside a container
# and are best-effort by design: the cursor track (the server reads the macOS
# cursor, which a Linux container cannot see) and GPU transcription (run
# whisper.cpp on the host; the server reaches it through host.docker.internal).

FROM oven/bun:1.3-slim AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bunx --bun vite build

FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production \
    CUTLINE_HOST=0.0.0.0 \
    CUTLINE_PORT=5311 \
    CUTLINE_HOME=/data
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production && mkdir -p /data && chown bun:bun /data
# The server imports the editor's pure modules (schemas, transcript, effects).
COPY server ./server
COPY src ./src
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 5311
VOLUME /data
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD bun -e "fetch('http://127.0.0.1:5311/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "server/index.ts"]
