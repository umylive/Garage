FROM node:20-alpine

# Install build tools for better-sqlite3
RUN apk add --no-cache python3 make g++ tini imagemagick

WORKDIR /app

COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

COPY backend ./backend
COPY frontend ./frontend

RUN convert frontend/icon-source.png -resize 512x512! frontend/icon-512.png \
 && convert frontend/icon-source.png -resize 192x192! frontend/icon-192.png

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/server.js"]
