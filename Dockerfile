FROM node:22-slim

# better-sqlite3 ships prebuilt binaries for this platform; build tools are
# only needed if npm has to compile from source.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000

# Mount a volume here so the database survives redeploys.
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
