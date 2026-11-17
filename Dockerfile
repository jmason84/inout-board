# IN/OUT Board - zero-dependency Node app (needs Node 22.5+ for node:sqlite)
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8443 \
    HTTPS=auto \
    DATA_DIR=/data

WORKDIR /app
COPY package.json server.js ./
COPY public ./public
COPY assets ./assets
COPY scripts ./scripts

# /data holds the SQLite database and uploaded photos - mount a volume here.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
