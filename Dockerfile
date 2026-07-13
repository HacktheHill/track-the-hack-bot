FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 1001 bot && useradd --system --uid 1001 --gid bot bot
COPY --from=build --chown=bot:bot /app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=bot:bot /app/dist ./dist
USER bot
EXPOSE 4000
STOPSIGNAL SIGTERM
CMD ["node", "dist/bot.js"]
