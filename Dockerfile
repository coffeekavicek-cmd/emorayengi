FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
