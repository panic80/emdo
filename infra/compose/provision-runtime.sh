#!/usr/bin/env bash
set -Eeuo pipefail

export PGPASSWORD="$(tr -d '\r\n' < /run/secrets/postgres_superuser_password)"
exec psql \
  --host postgres \
  --username postgres \
  --dbname emdo_app \
  --set ON_ERROR_STOP=1 \
  --file /opt/emdo/provision-runtime.sql
