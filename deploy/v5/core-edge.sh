#!/usr/bin/env bash
# Serve the public Core ingress host (core.megaxo.online) from the V5 PRODUCTION authority.
#
# The signed /ingress/* surface belongs to the one production Core. This used to be an unsupervised
# nohup process pointing at 127.0.0.1:8085 (the V5.1 STAGING server), so the public Core host verified
# the staging gateway secret and the production API's signed calls would have been rejected. The unit
# binds the host side of the Docker backend network (172.18.0.1) where Caddy reaches it, and forwards
# to the production server's 172.18.0.1:8080 ingress.
set -uo pipefail
exec /opt/mega-xo-v5-production/bin/node-24/bin/node \
  /opt/mega-xo-v5-production/src-final/scripts/v51/core-edge-proxy.cjs \
  --host 172.18.0.1 --allow-private-bind --port 8096 \
  --upstream-host 172.18.0.1 --upstream-port 8080
