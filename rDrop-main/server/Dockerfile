# syntax=docker/dockerfile:1.6
FROM node:lts-alpine AS base

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /home/node/app

# Install dependencies first to leverage Docker layer caching
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the source code
COPY --chown=node:node . .

EXPOSE 3000
USER node

CMD ["node", "index.js"]
