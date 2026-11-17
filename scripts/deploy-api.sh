#!/usr/bin/env bash
# npm run deploy:api — ship the online API to John's Linode (README
# "Deploying"). Needs SSH as root to the Linode, so it runs from John's
# machine; a cloud session cannot deploy the API.
#
# Bundles server/linode.ts to one self-contained file, copies it to
# /opt/tyrants-api, restarts tyrants-api.service, and checks /api/health both
# on the box and through the tunnel. The previous bundle is kept as
# tyrants-api.prev.mjs; to roll back:
#   ssh root@$HOST 'cp /opt/tyrants-api/tyrants-api.prev.mjs /opt/tyrants-api/tyrants-api.mjs && systemctl restart tyrants-api'
set -euo pipefail
HOST="${TYRANTS_API_HOST:-root@172.232.14.119}"
PUBLIC="${TYRANTS_API_ORIGIN:-https://tyrants-api.johnchampaign.com}"

npm run build:api
rev=$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- src server functions package.json package-lock.json || echo '+dirty')
echo "deploying Tyrants API $rev to $HOST"
scp -q dist-api/tyrants-api.mjs "$HOST:/opt/tyrants-api/tyrants-api.next.mjs"
ssh "$HOST" "set -e; cd /opt/tyrants-api
  [ -f tyrants-api.mjs ] && cp tyrants-api.mjs tyrants-api.prev.mjs
  mv tyrants-api.next.mjs tyrants-api.mjs && echo '$rev' > REVISION
  systemctl restart tyrants-api
  for i in \$(seq 20); do curl -fsS http://127.0.0.1:8394/api/health >/dev/null 2>&1 && break; sleep 0.5; done
  curl -fsS http://127.0.0.1:8394/api/health"
echo
curl -fsS "$PUBLIC/api/health" && echo && echo "Tyrants API $rev live at $PUBLIC"
