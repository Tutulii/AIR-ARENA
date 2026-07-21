FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.22.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 1001 airarena \
    && useradd --system --uid 1001 --gid airarena --create-home airarena
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build --chown=airarena:airarena /app/dist ./dist
USER airarena
EXPOSE 3000
CMD ["node", "dist/entrypoint.js"]
