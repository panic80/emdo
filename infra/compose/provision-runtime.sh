#!/usr/bin/env bash
set -Eeuo pipefail

PGPASSWORD="$(tr -d '\r\n' < /run/secrets/postgres_superuser_password)"
export PGPASSWORD
exec psql \
  --host postgres \
  --username postgres \
  --dbname emdo_app \
  --set ON_ERROR_STOP=1 \
  --file /opt/emdo/provision-runtime.sql
