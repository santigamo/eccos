FROM oven/bun:1.3

WORKDIR /app

# Install dependencies first for better layer caching.
# Copy the workspace root manifest + the only workspace package the Bun target needs (@eccos/core).
COPY package.json bun.lock* ./
COPY packages/core/package.json packages/core/package.json
RUN bun install --production

COPY . .

ENV DATABASE_PATH=/app/data/eccos.db
VOLUME /app/data
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
