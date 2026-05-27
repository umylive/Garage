FROM node:20-alpine

# Install build tools for better-sqlite3
RUN apk add --no-cache python3 make g++ tini librsvg

WORKDIR /app

COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

COPY backend ./backend
COPY frontend ./frontend

RUN rsvg-convert -w 192 -h 192 frontend/icon.svg -o frontend/icon-192.png \
 && rsvg-convert -w 512 -h 512 frontend/icon.svg -o frontend/icon-512.png

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/server.js"]
