FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    DATA_DIR=/app/data

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js index.html app.js styles.css ./

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '4173') + '/api/health').then((res) => { if (!res.ok) process.exit(1); return res.json(); }).then((body) => { if (!body.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "server.js"]
