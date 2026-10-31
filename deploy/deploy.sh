#!/bin/sh
# Ships the committed code (git HEAD, nothing uncommitted) to the server and
# rebuilds it there. The server keeps its own .env in DEPLOY_DIR.
#   DEPLOY_HOST=ubuntu@1.2.3.4 DEPLOY_KEY=~/.ssh/key sh deploy/deploy.sh
# Shaped after at-cost/glasstrack's deploy script (MIT).
set -eu
: "${DEPLOY_HOST:?set DEPLOY_HOST, e.g. ubuntu@1.2.3.4}"
KEY_OPT=""
[ -n "${DEPLOY_KEY:-}" ] && KEY_OPT="-i $DEPLOY_KEY"
DIR="${DEPLOY_DIR:-/srv/dropisode}"
cd "$(dirname "$0")/.."
REV=$(git rev-parse --short HEAD)
echo "Deploying $REV to $DEPLOY_HOST:$DIR"
git archive --format=tar HEAD | ssh $KEY_OPT "$DEPLOY_HOST" "mkdir -p $DIR/src && cd $DIR/src && find . -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} + && tar -xf - && echo $REV > REVISION"
# Caddy mounts deploy/Caddyfile as a single file; a deploy replaces that file, so a running
# Caddy keeps reading the old copy. Restart it when the config changed.
ssh $KEY_OPT "$DEPLOY_HOST" "cd $DIR/src && ln -sfn $DIR/.env .env && \
  docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build --wait --wait-timeout 600 && \
  if ! docker exec src-caddy-1 cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - deploy/Caddyfile; then docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml restart caddy; fi && \
  docker image prune -f >/dev/null && docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml ps --format '{{.Service}}: {{.Status}}'"
echo "Deployed $REV"
