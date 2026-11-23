#!/bin/sh
# Runs once, when the Postgres data volume is first initialised.
# Creates the application role (non-superuser) and hands it ownership of the app database.
# CREATEDB is granted only so `prisma migrate dev` can create its temporary shadow database
# in local development; production roles must not have it (see docs/SECURITY.md).
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v app_user="$APP_DB_USER" \
  -v app_password="$APP_DB_PASSWORD" \
  -v app_db="$POSTGRES_DB" <<'EOSQL'
CREATE ROLE :"app_user" WITH LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEROLE CREATEDB;
ALTER DATABASE :"app_db" OWNER TO :"app_user";
ALTER SCHEMA public OWNER TO :"app_user";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL
