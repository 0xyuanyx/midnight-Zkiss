FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY web/package.json web/package.json
COPY contract/package.json contract/package.json
COPY e2e/package.json e2e/package.json
RUN npm ci --no-audit --no-fund
COPY midnight/package.json midnight/package-lock.json midnight/
RUN npm ci --prefix midnight --no-audit --no-fund
COPY backend backend
COPY midnight midnight
COPY deploy/gcp deploy/gcp
WORKDIR /app/backend
CMD ["node", "--import", "tsx", "src/server.ts"]
