# KnockKnock FCC Extension — TypeScript implementation for Flare Confidential Compute.
#
# Build:
#   docker build -f fcc/typescript/Dockerfile -t knockknock-fcc .
#
# Run locally (expects the tee-node binary to be injected by docker-compose in a real stack):
#   docker run -p 7702:7702 -e TEE_SIGNER_PRIVATE_KEY=0x... knockknock-fcc

# --- Stage 1: build tee-node ./server from the published GitHub repo ---
FROM golang:1.25.1-trixie@sha256:ff83f3762390c2cccb53618ccc18af23e556aff9b1db4428637e9f63287c8171 AS node-builder

ARG SOURCE_DATE_EPOCH
ENV SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH

WORKDIR /build

# Pin tee-node by commit SHA for supply-chain reproducibility.
ARG TEE_NODE_COMMIT_SHA=cafed00d
RUN git clone --depth 1 https://github.com/flare-foundation/tee-node.git ./tee-node \
    && cd ./tee-node \
    && git fetch --depth 1 origin ${TEE_NODE_COMMIT_SHA} \
    && git checkout ${TEE_NODE_COMMIT_SHA}

WORKDIR /build/tee-node
RUN go mod download && go mod verify
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOFLAGS="-buildvcs=false" \
    go build -trimpath -ldflags="-buildid= -s -w" -o /app/server ./cmd/extension

# --- Stage 2: build the TypeScript extension ---
FROM node:22-trixie AS ext-builder

WORKDIR /ext

COPY --chmod=644 --chown=0:0 fcc/typescript/package.json fcc/typescript/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY --chmod=644 --chown=0:0 fcc/typescript/ ./
RUN npm run build

# --- Stage 3: runtime with pinned Node 22 ---
FROM node:22-trixie-slim AS runtime

ARG SOURCE_DATE_EPOCH
ENV SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH

WORKDIR /app

RUN \
  --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update && \
  apt-get install -y --no-install-recommends ca-certificates && \
  rm -rf /var/lib/apt/lists/* /var/log/* /var/cache/ldconfig/aux-cache

COPY --chmod=755 --chown=0:0 --from=node-builder /app/server /app/server
COPY --chmod=644 --chown=0:0 --from=node-builder /build/tee-node/assets/google_confidential_space_root.crt /app/assets/google_confidential_space_root.crt
COPY --chmod=644 --chown=0:0 --from=ext-builder /ext/dist /app/extension/dist
COPY --chmod=644 --chown=0:0 --from=ext-builder /ext/node_modules /app/extension/node_modules
COPY --chmod=644 --chown=0:0 --from=ext-builder /ext/package.json /app/extension/package.json

RUN find /app -exec touch -h -d @${SOURCE_DATE_EPOCH} {} +

ENV MODE=0 CONFIG_PORT=5501 SIGN_PORT=7701 EXTENSION_PORT=7702

LABEL "tee.launch_policy.allow_env_override"="LOG_LEVEL,PROXY_URL,INITIAL_OWNER,EXTENSION_ID,CHAIN_URL,MODE,CONFIG_PORT,SIGN_PORT,EXTENSION_PORT,FLARE_RPC_URL,IDENTITY_API_URL,TEE_SIGNER_PRIVATE_KEY"

EXPOSE 5501 7701 7702

CMD ["/bin/bash", "-c", "/app/server & SERVER_PID=$!; node /app/extension/dist/main.js & EXT_PID=$!; wait -n $SERVER_PID $EXT_PID; kill -TERM $SERVER_PID $EXT_PID 2>/dev/null; exit 1"]
