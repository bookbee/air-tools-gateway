# syntax=docker/dockerfile:1
# Multi-stage, non-root runtime for air-tools-gateway. The final image holds compiled JS,
# production dependencies and the fixture data, and nothing else: no TypeScript, no tests,
# no dev tooling.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN useradd --create-home --uid 10001 air
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY fixtures ./fixtures
USER air
EXPOSE 8080

# Liveness only. /v1/ready would mark the container unhealthy whenever a backend blinked.
HEALTHCHECK --interval=15s --timeout=3s --retries=5 --start-period=5s \
  CMD ["node", "-e", "fetch('http://localhost:8080/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "dist/src/main.js"]
