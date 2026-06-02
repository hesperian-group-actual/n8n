FROM node:22-alpine AS builder

WORKDIR /build

RUN apk add --no-cache python3 make g++ git

# Enable corepack for pnpm
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ ./patches/
COPY packages/ ./packages/
COPY scripts/ ./scripts/
COPY turbo.json biome.jsonc tsconfig.json ./

# Install and build, then create pruned deployment
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN NODE_ENV=production DOCKER_BUILD=true pnpm --filter=n8n --prod --legacy deploy --no-optional /compiled

# Rebuild native modules for Alpine
RUN cd /compiled && \
    npm rebuild sqlite3 && \
    rm -rf node_modules/isolated-vm/prebuilds && \
    cd node_modules/isolated-vm && \
    npx --yes node-gyp rebuild --release -j max

# ---- Runtime ----
FROM node:22-alpine

RUN apk add --no-cache tini

ENV NODE_ENV=production
ENV N8N_PORT=5678
ENV N8N_HOST=0.0.0.0

WORKDIR /home/node

COPY --from=builder /compiled /home/node

RUN ln -s /home/node/bin/n8n /usr/local/bin/n8n && \
    mkdir -p /home/node/.n8n && \
    chown -R node:node /home/node

EXPOSE 5678

USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["n8n", "start"]
