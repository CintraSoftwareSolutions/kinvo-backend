#!/bin/bash
set -euo pipefail

# Deploys the Kinvo API onto the staging instance.
#
# Runs ON the instance, fetched from S3 and executed through SSM. It exists as a
# file rather than inline SSM commands because quoting a multi-step shell script
# through JSON is how mistakes get made.
#
# Why the image is built here rather than pushed:
# an 877MB push from a slow uplink times out repeatedly, while the source is
# 280KB and AWS builds it in a couple of minutes on its own network.
#
# Usage (from the instance, or via SSM):
#   deploy.sh <s3-bucket> <image-tag>

BUCKET="$1"
IMAGE="$2"

APP_DIR=/opt/kinvo
SRC_DIR="$APP_DIR/src"

echo "=== fetching source ==="

# The extraction directory is REPLACED, not written over.
#
# `tar xzf` unpacks the archive on top of whatever is already there and never
# removes a file the archive does not contain. So every file deleted in a commit
# stayed on this instance from the previous deploy, and the build compiled a mix
# of the new tree and orphans of the old one.
#
# That is not a subtle failure either: a deleted module keeps importing packages
# that have since been uninstalled and symbols that no longer exist, so tsc
# fails on files that are not in the repository any more — and the error names
# paths a developer cannot find, because locally they are gone.
#
# Deleting the directory first makes the deployed tree exactly the archive.
# Safe because it holds nothing but extracted source: .env and the compose file
# live in $APP_DIR, one level up.
rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR"
cd "$SRC_DIR"
aws s3 cp "s3://$BUCKET/_deploy/kinvo-src.tar.gz" . --region us-east-1
tar xzf kinvo-src.tar.gz

# Build output goes to a FILE, not through `tail`.
#
# It used to be piped straight into `tail -5`, which is fine when the build
# works and useless when it does not: a compile error scrolls past in the
# discarded lines and the deploy log shows only "exit code: 2". Diagnosing that
# meant reproducing the build somewhere else to see an error the instance had
# already printed.
#
# On success only the last few lines are echoed, so a working deploy stays
# readable. On failure the tail of the real output is printed and the whole log
# is kept on disk.
BUILD_LOG=/tmp/kinvo-build.log

build_image() {
  local label="$1"
  shift

  echo "=== building $label ==="

  if docker build "$@" . > "$BUILD_LOG" 2>&1; then
    tail -3 "$BUILD_LOG"
    return 0
  fi

  echo "--- BUILD FAILED: last 60 lines of $BUILD_LOG ---"
  tail -60 "$BUILD_LOG"
  echo "--- compiler diagnostics, if any ---"
  grep -E "error TS[0-9]+|FATAL ERROR|heap out of memory|Killed" "$BUILD_LOG" | head -30 || true
  echo "--- full log retained at $BUILD_LOG ---"
  return 1
}

build_image "runtime image" -t "$IMAGE"

# The runtime image installs production dependencies only, so the Prisma CLI is
# absent by design — it is a build tool, not something the API needs at run
# time. Migrations therefore run from the builder stage, which has it. This also
# keeps the CLI and its dependencies out of the image that faces the internet.
build_image "migrator (builder stage)" --target builder -t kinvo-migrator

echo "=== applying migrations ==="
docker run --rm \
  --network kinvo_default \
  --env-file "$APP_DIR/.env" \
  kinvo-migrator npx prisma migrate deploy 2>&1 | tail -15

echo "=== starting api ==="
cd "$APP_DIR"
docker compose up -d api

echo "=== waiting for health ==="
for i in $(seq 1 30); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "api healthy after ${i}0s"
    break
  fi
  sleep 10
done

docker compose ps --format '{{.Name}} | {{.Status}}'
echo "=== deploy complete ==="
