FROM node:22-slim
# The slim image has no CA bundle: Node carries its own, but Python's HTTP client trusts only the system store, so
# without this every SAM call failed with "Connection error" while Spark (Node) worked.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_CACHE_DIR=/opt/uv-cache UV_PYTHON_INSTALL_DIR=/opt/uv-python
COPY package*.json ./
RUN npm ci
COPY . .
# Build the game, and install the Python helpers' dependencies now so the first room doesn't wait for them.
RUN npm run build && npm run build:server && (uv run -q server/sam.py >/dev/null 2>&1; uv run -q server/shrink.py >/dev/null 2>&1; true)
# Fail the build, not the first room, if Python can't verify TLS (a 401 is fine: only the handshake matters here).
RUN uv run -q --with httpx python -c "import httpx; httpx.get('https://api.meta.ai/v1/models')"
ENV PORT=8080 DATA=/data META_LEDGER=/data/spend.json ACCESS_LEDGER=/data/access.json
# The server is bundled at build time (server/bundle.mjs, next to the Python helpers it calls), so a cold start doesn't
# compile TypeScript.
CMD ["node", "server/bundle.mjs"]
