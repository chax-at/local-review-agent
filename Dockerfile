# syntax = docker/dockerfile:1

ARG from_registry=docker.io
ARG from_repository=library/node
ARG from_tag=24
FROM ${from_registry}/${from_repository}:${from_tag} as base_nodejs
USER www-data
WORKDIR /srv/www/app


FROM base_nodejs AS base_files
COPY --chown=www-data:www-data . .


FROM base_files AS prebuild_lint
RUN npm run ci:lint && touch /tmp/.done


FROM base_files AS build
COPY --from=prebuild_lint /tmp/.done /tmp/.prebuild_lint.done
RUN npm run ci:build


FROM base_nodejs AS final
# Runs as www-data. Volume dirs (data/, repos/) must be writable by www-data.
# Use the helper script `tools/fix-data-perms.sh` or docker-compose init container
# if you see EACCES errors after switching between local dev and Docker.
# pi itself runs in the separate lgr-pi-runner image (tools/pi-runner.Dockerfile),
# spawned via `docker run` — it is not installed in this app image.
COPY --from=build --chown=www-data:www-data /srv/www/app/package*.json .
COPY --from=build --chown=www-data:www-data /srv/www/app/node_modules node_modules
COPY --from=build --chown=www-data:www-data /srv/www/app/config config
COPY --from=build --chown=www-data:www-data /srv/www/app/dist dist

# The heartbeat is touched before every poll cycle, every PR, and every review
# run, but a single run calls pi through a synchronous spawnSync that blocks the
# event loop until Docker returns — up to MODELn_TIMEOUT_MS (300s default) plus
# 30s container startup plus 60s per diff chunk. The window must exceed that
# worst case, or a legitimately long review reports the process as unhealthy.
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD test $(( $(date +%s) - $(date -d "$(cat /srv/www/app/data/heartbeat)" +%s) )) -lt 1800 || exit 1

CMD ["node", "dist/src/main-server.js"]
