# open-rc — all-in-one image.
#
# One image, the whole CLI: `serve` (default), `hub`, and `tui`. Runs
# straight from the TypeScript source with Bun — no build step, same
# as the repo's no-build philosophy. The container never runs
# `claude`: it is the relay side only. `/attach-orc` (bridge + hooks)
# runs on the host next to your claude and dials the published port.
#
#   docker build -t open-rc .
#   docker run -d -p 127.0.0.1:7322:7322 -v open-rc-data:/data open-rc
#   # or: docker compose up -d
#
# Other commands ride the same image:
#   docker run --rm -it open-rc tui --server ws://host.docker.internal:7322/ws
#   docker run -d -p 7443:7443 open-rc hub --host 0.0.0.0 --port 7443

FROM oven/bun:1.3-slim

WORKDIR /app

# Dependency layer — cached until the lockfile changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App code: server source + the SPA (served straight off disk).
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui

# All mutable state (VAPID keys, push subscriptions, audit log) honors
# XDG_DATA_HOME, so one volume holds everything the relay persists.
ENV XDG_DATA_HOME=/data
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data

USER bun
EXPOSE 7322

# The image ships Bun, so Bun is the health prober too (no curl).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:7322/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# 0.0.0.0 INSIDE the container; publish-time -p decides real exposure
# (docker-compose.yml binds it to 127.0.0.1 on the host by default).
ENTRYPOINT ["bun", "run", "src/cli.ts"]
CMD ["serve", "--host", "0.0.0.0", "--port", "7322"]
