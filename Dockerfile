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
FROM ${from_registry}/${from_repository}:${from_tag} AS security_tools
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


FROM base_nodejs AS final
# Runs as www-data. Volume dirs (data/, repos/) must be writable by www-data.
# Use the helper script `tools/fix-data-perms.sh` or docker-compose init container
# if you see EACCES errors after switching between local dev and Docker.
# pi itself runs in the separate lgr-pi-runner image (tools/pi-runner.Dockerfile),
# spawned via `docker run` — it is not installed in this app image.
COPY --from=security_tools /usr/local/bin/gitleaks /usr/local/bin/gitleaks
COPY --from=security_tools /opt/semgrep-venv /opt/semgrep-venv
ENV PATH="/opt/semgrep-venv/bin:${PATH}"
COPY --from=build --chown=www-data:www-data /srv/www/app/package*.json .
COPY --from=build --chown=www-data:www-data /srv/www/app/node_modules node_modules
COPY --from=build --chown=www-data:www-data /srv/www/app/config config
COPY --from=build --chown=www-data:www-data /srv/www/app/dist dist
COPY --from=build --chown=www-data:www-data /srv/www/app/security-rules security-rules

# The heartbeat is touched before every poll cycle, every PR, and every review
# run, but a single run calls pi through a synchronous spawnSync that blocks the
# event loop until Docker returns — up to MODELn_TIMEOUT_MS (300s default) plus
# 30s container startup plus 60s per diff chunk. The window must exceed that
# worst case, or a legitimately long review reports the process as unhealthy.
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD test $(( $(date +%s) - $(date -d "$(cat /srv/www/app/data/heartbeat)" +%s) )) -lt 1800 || exit 1

CMD ["node", "dist/src/main-server.js"]
