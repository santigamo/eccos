FROM oven/bun:1.3

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json bun.lock* ./
RUN bun install --production

COPY . .

ENV DATABASE_PATH=/app/data/eccos.db
VOLUME /app/data
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
