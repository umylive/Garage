FROM node:20-alpine

# Install build tools for better-sqlite3
RUN apk add --no-cache python3 make g++ tini

WORKDIR /app

COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

COPY backend ./backend
COPY frontend ./frontend
COPY generate-icons.js ./

RUN node generate-icons.js

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/server.js"]
