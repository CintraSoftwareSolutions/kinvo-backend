#!/bin/bash
set -euxo pipefail

# Boots the Kinvo API on a fresh Amazon Linux 2023 instance.
#
# Runs once, as root, at first boot. Output goes to
# /var/log/cloud-init-output.log — read that first when something is wrong.
#
# Postgres and Redis run here in containers rather than as RDS and ElastiCache.
# That is a deliberate staging trade: about $27/month cheaper, and staging data
# is disposable so managed backups buy little. Production should use the managed
# services, which is a change to this file and the security groups, not to the
# application.

dnf update -y
dnf install -y docker

# Compose v2 as a Docker CLI plugin. x86_64 to match the instance: the wrong
# architecture here does not fail until the first compose command runs.
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

systemctl enable --now docker

APP_DIR=/opt/kinvo
mkdir -p "$APP_DIR"

# --- secrets ---------------------------------------------------------------
# Read from SSM through the instance role. Never baked into the image, never
# written to a file that outlives this script.
get_secret() {
  aws ssm get-parameter \
    --name "/${project}/${environment}/$1" \
    --with-decryption \
    --region "${aws_region}" \
    --query 'Parameter.Value' \
    --output text
}

# Tracing OFF before the secrets are read.
#
# `set -x` echoes every assignment, so with it on the JWT keys and the database
# password are written in plaintext to /var/log/cloud-init-output.log — which
# defeats the entire point of holding them in SSM SecureStrings. Everything
# between here and the end of the env files runs untraced.
set +x

JWT_ACCESS_SECRET="$(get_secret jwt_access_secret)"
JWT_REFRESH_SECRET="$(get_secret jwt_refresh_secret)"
DB_PASSWORD="$(get_secret db_password)"

# --- environment -----------------------------------------------------------
# NODE_ENV=production is not cosmetic. It is what makes env validation refuse a
# wildcard CORS origin and refuse MEDIA_AUTO_APPROVE_UPLOADS, and what stops
# forgot-password returning the reset token in the response body.
#
# No S3_ENDPOINT and no S3 keys: the SDK talks to real S3 and authenticates
# through the instance role.
cat > "$APP_DIR/.env" <<ENVFILE
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=${log_level}

DATABASE_URL=postgresql://kinvo:$DB_PASSWORD@postgres:5432/kinvo
REDIS_URL=redis://redis:6379

JWT_ACCESS_SECRET=$JWT_ACCESS_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET
JWT_ISSUER=kinvo

CORS_ORIGINS=https://admin.${project}.invalid
JSON_BODY_LIMIT=1mb

S3_REGION=${aws_region}
S3_MEDIA_BUCKET=${media_bucket}
S3_VERIFICATION_BUCKET=${verification_bucket}
S3_FORCE_PATH_STYLE=false
MEDIA_AUTO_APPROVE_UPLOADS=false

# No Twilio, Google, or Apple accounts exist for this project yet. Without this
# waiver the API refuses to boot in production mode, which is the correct
# default — OTP and social sign-in failing at a user's first request is far
# harder to notice than failing at deploy time.
#
# With it, those endpoints return SERVICE_UNAVAILABLE when called, which is
# honest. MUST become true the moment real users can sign in.
REQUIRE_THIRD_PARTY_INTEGRATIONS=false

# Email through SES. No credentials: the instance role signs the calls.
SES_SENDER_ADDRESS=${ses_sender_address}
SES_CONFIGURATION_SET=${ses_configuration_set}

# No S3 keys. The instance role supplies credentials, so there is no long-lived
# secret on the box at all.
ENVFILE

# Firebase service account, appended separately.
#
# It is a JSON document containing a PEM private key, so it cannot go in the
# heredoc above without the shell mangling it. Written with printf %s so the
# value lands verbatim, and never written to its own file on disk -- a key file
# on a box is a key file that ends up in an image, a backup, or a support
# ticket.
FIREBASE_JSON=$(get_secret firebase_service_account 2>/dev/null || true)

if [ -n "$FIREBASE_JSON" ]; then
  printf 'FIREBASE_SERVICE_ACCOUNT_JSON=%s
' "$FIREBASE_JSON" >> "$APP_DIR/.env"
fi

chmod 600 "$APP_DIR/.env"

cat > "$APP_DIR/db.env" <<DBENV
POSTGRES_USER=kinvo
POSTGRES_PASSWORD=$DB_PASSWORD
POSTGRES_DB=kinvo
DBENV

chmod 600 "$APP_DIR/db.env"

# Secrets are now only in root-owned 600 files. Safe to trace again.
set -x

# --- compose ---------------------------------------------------------------
cat > "$APP_DIR/docker-compose.yml" <<'COMPOSE'
name: kinvo

services:
  postgres:
    image: postgis/postgis:16-3.4
    restart: unless-stopped
    env_file: [db.env]
    volumes:
      - pgdata:/var/lib/postgresql/data
    # No ports mapping: reachable only on the compose network, never from
    # outside the instance.
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U kinvo -d kinvo']
      interval: 5s
      timeout: 5s
      retries: 20

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ['redis-server', '--appendonly', 'yes']
    volumes:
      - redisdata:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 20

  api:
    image: API_IMAGE_PLACEHOLDER
    restart: unless-stopped
    env_file: [.env]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    expose:
      - '3000'

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddydata:/data
      - caddyconfig:/config
    # Deliberately no depends_on. Caddy proxying a service that is not up yet
    # returns 502 for a moment; making it depend on the API means Caddy cannot
    # start at all before the first image exists, which is exactly the state a
    # freshly created instance is in.

volumes:
  pgdata:
  redisdata:
  caddydata:
  caddyconfig:
COMPOSE

sed -i "s|API_IMAGE_PLACEHOLDER|${ecr_repository}:latest|" "$APP_DIR/docker-compose.yml"

# --- Caddy -----------------------------------------------------------------
# With a domain, Caddy obtains and renews a Let's Encrypt certificate itself.
# Without one, it serves plain HTTP and CloudFront provides TLS to the client —
# a certificate authority will not issue for a bare IP address.
if [ -n "${domain_name}" ]; then
  cat > "$APP_DIR/Caddyfile" <<CADDY
${domain_name} {
  encode gzip
  reverse_proxy api:3000
}
CADDY
else
  # Unquoted heredoc so $ORIGIN_SECRET expands. Braces are avoided throughout
  # this file because Terraform's templatefile() consumes $${...} before the
  # shell ever sees it.
  ORIGIN_SECRET=$(get_secret origin_secret)

  cat > "$APP_DIR/Caddyfile" <<CADDY
:80 {
  # Only our CloudFront distribution carries this header. The security group
  # already limits callers to CloudFront's address ranges, but those ranges
  # cover every CloudFront customer -- anyone could aim their own distribution
  # at this IP and be inside the allowed CIDRs. This is what makes it ours.
  @unauthorised not header X-Origin-Secret "$ORIGIN_SECRET"
  respond @unauthorised 403

  encode gzip
  reverse_proxy api:3000
}
CADDY
fi

# --- backups ---------------------------------------------------------------
# Postgres runs in a container on THIS instance with its data in a local
# volume, so the instance is the database. Until that moves to RDS, these dumps
# are the only recovery path from a terminated instance.
cat > /usr/local/bin/kinvo-backup.sh <<'BACKUP'
#!/bin/bash
set -euo pipefail

BUCKET="__MEDIA_BUCKET__"
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
FILE="/tmp/kinvo-$STAMP.sql.gz"

# --clean --if-exists so the dump replays into a non-empty database without
# hand-editing, which is exactly the situation a restore happens in.
docker exec kinvo-postgres-1 pg_dump -U kinvo -d kinvo --clean --if-exists   | gzip -9 > "$FILE"

SIZE=$(stat -c%s "$FILE")

# pg_dump can fail after writing a header. Uploading that would quietly replace
# a good backup with a useless one.
if [ "$SIZE" -lt 1000 ]; then
  echo "backup too small ($SIZE bytes) - refusing to upload"
  rm -f "$FILE"
  exit 1
fi

aws s3 cp "$FILE" "s3://$BUCKET/_backups/kinvo-$STAMP.sql.gz" --region __AWS_REGION__
rm -f "$FILE"
echo "backup uploaded: $SIZE bytes"
BACKUP

sed -i "s|__MEDIA_BUCKET__|${media_bucket}|; s|__AWS_REGION__|${aws_region}|" /usr/local/bin/kinvo-backup.sh
chmod +x /usr/local/bin/kinvo-backup.sh

cat > /etc/systemd/system/kinvo-backup.service <<'UNIT'
[Unit]
Description=Kinvo database backup to S3
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/kinvo-backup.sh
UNIT

cat > /etc/systemd/system/kinvo-backup.timer <<'UNIT'
[Unit]
Description=Nightly Kinvo database backup

[Timer]
# After the 00:10 deck-generation job, and clear of the UTC-midnight quota
# reset when the database is busiest.
OnCalendar=*-*-* 03:20:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now kinvo-backup.timer

# --- start -----------------------------------------------------------------
aws ecr get-login-password --region "${aws_region}" \
  | docker login --username AWS --password-stdin "${ecr_repository}"

cd "$APP_DIR"

# The image only exists after the first push, so a first boot legitimately has
# nothing to pull. Postgres and Redis still come up, and the deploy script
# starts the API once an image is available.
docker compose pull || true
docker compose up -d postgres redis caddy
docker compose up -d api || echo "No API image yet — push one, then run: cd /opt/kinvo && docker compose up -d api"

echo "kinvo bootstrap complete"
