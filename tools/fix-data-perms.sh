#!/usr/bin/env sh
# Fix ownership of the data/ and repos/ volume directories that the bot
# reads/writes. The Docker image runs as www-data (uid 33); local dev runs as
# your own user. Switching between the two leaves these dirs owned by the wrong
# user, which causes EACCES errors. Run this before switching.
#
#   ./tools/fix-data-perms.sh docker   # before `docker compose up`
#   ./tools/fix-data-perms.sh local    # before `npm run start`
#
# Uses sudo because changing ownership to/from uid 33 requires root.
set -eu

mode="${1:-}"
mkdir -p data repos

case "$mode" in
  docker)
    sudo chown -R 33:33 data repos
    echo "data/ and repos/ now owned by uid 33 (www-data) — ready for Docker."
    ;;
  local)
    sudo chown -R "$(id -u):$(id -g)" data repos
    echo "data/ and repos/ now owned by $(id -un) — ready for local dev."
    ;;
  *)
    echo "Usage: $0 {docker|local}" >&2
    exit 1
    ;;
esac
