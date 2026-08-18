# Curanta — single-operator newsletter tool.
# Node 24 gives us a stable built-in node:sqlite (the app's database engine).
FROM node:24-slim

WORKDIR /app

# Install production deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

ENV NODE_ENV=production
# The host sets PORT; default 3000 if it doesn't.
ENV PORT=3000
# Keep the SQLite database on a mounted volume so data survives redeploys.
ENV DB_PATH=/data/curanta.db
# We run behind the platform's proxy.
ENV TRUST_PROXY=1

EXPOSE 3000

# initStore() creates /data on boot; mount a persistent volume there (see docs/deploy.md).
CMD ["node", "server.mjs"]
