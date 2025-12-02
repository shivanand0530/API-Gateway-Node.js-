FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/
COPY .env ./

RUN mkdir -p logs

RUN addgroup -g 1001 -S nodejs
RUN adduser -S gateway -u 1001

RUN chown -R gateway:nodejs /app
USER gateway

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health/live', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npm", "start"]