# syntax = docker/dockerfile:1

ARG from_registry=docker.io
ARG from_repository=library/node
ARG from_tag=24
FROM ${from_registry}/${from_repository}:${from_tag} AS base_nodejs
USER www-data
# node:24's www-data has no home dir (/var/www doesn't exist), so npm's cache
# write fails under this user unless HOME points somewhere it owns.
ENV HOME=/srv/www/app
WORKDIR /srv/www/app


# Runtime base for `final`. The full node image (~1.6 GB) carries compilers and
# headers the bot never uses; the slim one (~330 MB) lacks only what the bot
# calls at runtime: git (clone/fetch over HTTPS), python3 (the Semgrep venv
# links to /usr/bin/python3) and the CA bundle git needs for HTTPS.
FROM ${from_registry}/${from_repository}:${from_tag}-slim AS base_runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
USER www-data
ENV HOME=/srv/www/app
WORKDIR /srv/www/app


FROM base_nodejs AS base_files
COPY --chown=www-data:www-data . .


FROM base_files AS prebuild_lint
RUN npm run ci:lint && touch /tmp/.done


FROM base_files AS build
COPY --from=prebuild_lint /tmp/.done /tmp/.prebuild_lint.done
RUN npm run ci:build


# Installs Semgrep + gitleaks as root (this stage never switches user, unlike
# base_nodejs). Only the resulting binaries/venv are copied into `final`,
# which stays on www-data — no build tooling or package manager state leaks
# into the runtime image.
# Same slim base as `final`, so the venv's Python matches the python3 there.
FROM ${from_registry}/${from_repository}:${from_tag}-slim AS security_tools
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

ARG SEMGREP_VERSION=1.173.0
RUN python3 -m venv /opt/semgrep-venv \
 && /opt/semgrep-venv/bin/pip install --no-cache-dir "semgrep==${SEMGREP_VERSION}"

ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
RUN curl -fsSL -o /tmp/gitleaks.tar.gz \
      "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
 && echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks \
 && chmod +x /usr/local/bin/gitleaks \
 && rm /tmp/gitleaks.tar.gz


# Static Docker CLI. The bot runs pi (and the repo lint step) as sibling
# containers via `docker run` against the host daemon, and builds the
# lgr-pi-runner image via `docker build` — so the app image needs the client
# binary. The socket itself is mounted by docker-compose.yml.
FROM ${from_registry}/library/docker:cli AS docker_cli


FROM base_runtime AS final
# Runs as www-data. Volume dirs (data/, repos/, tmp/) must be writable by www-data.
# Use the helper script `tools/fix-data-perms.sh` or docker-compose init container
# if you see EACCES errors after switching between local dev and Docker.
# pi itself runs in the separate lgr-pi-runner image (tools/pi-runner.Dockerfile),
# spawned via `docker run` — it is not installed in this app image. That image
# is built from tools/ at startup, so tools/ ships in this image.
COPY --from=security_tools /usr/local/bin/gitleaks /usr/local/bin/gitleaks
COPY --from=security_tools /opt/semgrep-venv /opt/semgrep-venv
COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker
ENV PATH="/opt/semgrep-venv/bin:${PATH}"
COPY --from=build --chown=www-data:www-data /srv/www/app/package*.json .
COPY --from=build --chown=www-data:www-data /srv/www/app/node_modules node_modules
COPY --from=build --chown=www-data:www-data /srv/www/app/config config
COPY --from=build --chown=www-data:www-data /srv/www/app/dist dist
COPY --from=build --chown=www-data:www-data /srv/www/app/security-rules security-rules
COPY --from=build --chown=www-data:www-data /srv/www/app/tools tools

# The heartbeat is touched before every poll cycle, every PR, and every review
# run, but a single run calls pi through a synchronous spawnSync that blocks the
# event loop until Docker returns — up to MODELn_TIMEOUT_MS (300s default) plus
# 30s container startup plus 60s per diff chunk. The window must exceed that
# worst case, or a legitimately long review reports the process as unhealthy.
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD test $(( $(date +%s) - $(date -d "$(cat /srv/www/app/data/heartbeat)" +%s) )) -lt 1800 || exit 1

CMD ["node", "dist/src/main-server.js"]
