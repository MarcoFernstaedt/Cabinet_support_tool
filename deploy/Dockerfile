# syntax=docker/dockerfile:1
#
# The platform (server + console) and the Windows agent download, in one image for a demo deployment.
# Build from the repository root:  docker build -f deploy/Dockerfile -t cabinet-platform:local .
# deploy/compose.yaml does this for you.
#
# Stages:
#   contracts      the shared JSON Schemas and their loader (runtime dependency of the server)
#   console-build  the React console (npm ci && npm run build)
#   server-build   the TypeScript server (npm ci && npm run build)
#   server-deps    the server's production node_modules only
#   agent-build    the Windows agent, cross-published self-contained for win-x64 from Linux, zipped
#   runtime        node slim, non-root, serves both APIs and the console

# Base images are pinned by digest as well as by tag: a tag can be moved, a digest cannot. Dependabot proposes new ones; each is reviewed.
ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
ARG DOTNET_SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0.401-noble@sha256:e70cdb7f80b0348f5cb85f19a8f670fca061f033d57eed12fa003d58b0e06317

# ---------------------------------------------------------------- contracts
FROM ${NODE_IMAGE} AS contracts
WORKDIR /build/contracts
COPY contracts/package.json contracts/package-lock.json ./
# Production dependencies only (ajv). The generated TypeScript types are committed, so the generator is not needed.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY contracts/load.mjs contracts/load.d.mts ./
COPY contracts/schemas ./schemas
COPY contracts/generated ./generated
COPY contracts/trust ./trust
# The simulated cabinets of the demo build every answer from these valid examples.
COPY contracts/examples ./examples

# ---------------------------------------------------------------- console
FROM ${NODE_IMAGE} AS console-build
WORKDIR /build
COPY --from=contracts /build/contracts ./contracts
COPY console/package.json console/package-lock.json ./console/
RUN cd console && npm ci --ignore-scripts --no-audit --no-fund
COPY console/ ./console/
RUN cd console && npm run build

# ---------------------------------------------------------------- server
FROM ${NODE_IMAGE} AS server-build
WORKDIR /build
COPY --from=contracts /build/contracts ./contracts
COPY server/package.json server/package-lock.json ./server/
# --ignore-scripts: no dependency may run code at install time. (The browser tests are not run here, so no browser is fetched.)
RUN cd server && npm ci --ignore-scripts --no-audit --no-fund
COPY server/ ./server/
RUN cd server && npm run build

FROM ${NODE_IMAGE} AS server-deps
WORKDIR /build
COPY --from=contracts /build/contracts ./contracts
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------------------------------------------------------------- Windows agent
FROM ${DOTNET_SDK_IMAGE} AS agent-build
ARG AGENT_VERSION=
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# The agent compiles in the contract schemas and the trust lists (agent/src/Cabinet.Agent.Core/Cabinet.Agent.Core.csproj).
COPY contracts/schemas ./contracts/schemas
COPY contracts/trust ./contracts/trust
COPY agent/ ./agent/
# The same publish as agent/install/Publish-CabinetAgent.ps1: four programs, self-contained single files for win-x64.
# EnableWindowsTargeting (also set in agent/Directory.Build.props) lets the Windows projects build on Linux.
# The zip's layout is what Install-CabinetAgent.ps1 expects: its default -SourceDir is <script folder>\..\out.
RUN set -eu; \
    pkg=/pkg/CabinetAgent; mkdir -p "$pkg/out" "$pkg/install"; \
    for project in Cabinet.Agent.Broker Cabinet.Agent.Network Cabinet.Agent.Harness Cabinet.Agent.Updater; do \
      dotnet publish "agent/src/$project/$project.csproj" --configuration Release \
        --runtime win-x64 --self-contained true -p:PublishSingleFile=true -p:EnableWindowsTargeting=true \
        -p:NuGetLockFilePath=obj/publish.packages.lock.json -p:RestoreLockedMode=false \
        ${AGENT_VERSION:+-p:Version=$AGENT_VERSION} \
        --output "$pkg/out/$project"; \
    done; \
    find "$pkg/out" -name '*.pdb' -delete; \
    cp agent/install/Install-CabinetAgent.ps1 agent/install/Uninstall-CabinetAgent.ps1 "$pkg/install/"
COPY deploy/agent-README.txt /pkg/CabinetAgent/README.txt
RUN mkdir -p /agent-download && cd /pkg && zip -r -X -q /agent-download/CabinetAgent-win-x64.zip CabinetAgent \
    && sha256sum /agent-download/CabinetAgent-win-x64.zip | cut -d' ' -f1 > /agent-download/CabinetAgent-win-x64.zip.sha256

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
# NODE_ENV is deliberately not "production": the server refuses the development issuing CA in production,
# and this demo deployment uses that CA (DEV_PKI_DIR). A production deployment uses the KMS issuing key instead.
ENV CONSOLE_HOST=0.0.0.0 \
    CONSOLE_PORT=8080 \
    CONSOLE_STATIC_DIR=/opt/cabinet/console/dist \
    AGENT_API_HOST=0.0.0.0 \
    AGENT_API_PORT=8443 \
    DEV_PKI_DIR=/var/lib/cabinet/pki \
    PACKAGE_DIR=/var/lib/cabinet/packages \
    RELEASE_DIR=/var/lib/cabinet/releases \
    AGENT_DOWNLOAD_DIR=/opt/cabinet/agent-download
RUN groupadd --system --gid 10001 cabinet \
    && useradd --system --uid 10001 --gid cabinet --home-dir /nonexistent --shell /usr/sbin/nologin cabinet \
    && mkdir -p /var/lib/cabinet/pki /var/lib/cabinet/packages /var/lib/cabinet/releases \
    && chown -R cabinet:cabinet /var/lib/cabinet && chmod 700 /var/lib/cabinet/pki /var/lib/cabinet/packages /var/lib/cabinet/releases
WORKDIR /opt/cabinet
# The layout matches the repository, because the server finds its migrations, the contracts and the console by relative path.
COPY --from=contracts /build/contracts ./contracts
COPY --from=server-deps /build/server/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/migrations ./server/migrations
COPY --from=server-build /build/server/dist/src ./server/dist/src
COPY --from=console-build /build/console/dist ./console/dist
COPY --from=agent-build /agent-download ./agent-download
COPY deploy/database-setup.mjs ./deploy/database-setup.mjs
USER cabinet
# 8443: the agent API (mutual TLS, terminated by Node; publish it directly). 8080: the console (plain HTTP, behind Caddy only).
EXPOSE 8443 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "/opt/cabinet/server/dist/src/main.js"]
