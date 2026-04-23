FROM oven/bun:1 AS base

# Install Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source
COPY src/ src/
COPY public/ public/

# Data volume
RUN mkdir -p data/profiles
VOLUME /app/data

ENV CHROME_PATH=/usr/bin/chromium
ENV CHROME_NO_SANDBOX=1

EXPOSE 20000

CMD ["bun", "run", "src/index.ts"]
