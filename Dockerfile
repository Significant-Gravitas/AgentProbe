FROM oven/bun:1.3.12 AS build

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY dashboard/package.json dashboard/package.json
RUN bun install --frozen-lockfile

COPY . .
RUN bun run dashboard:build

FROM oven/bun:1.3.12-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    AGENTPROBE_SERVER_DATA=/app/data \
    AGENTPROBE_SERVER_DB=/app/.agentprobe/runs.sqlite3 \
    AGENTPROBE_SERVER_DASHBOARD_DIST=/app/dashboard/dist \
    AGENTPROBE_SERVER_LOG_FORMAT=json

COPY --from=build /app /app

EXPOSE 7878

CMD ["bun", "run", "./src/cli/main.ts", "start-server", "--host", "0.0.0.0", "--port", "7878", "--unsafe-expose"]
