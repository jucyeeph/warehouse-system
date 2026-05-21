#!/bin/sh
set -eu

# Reset test NAS sandbox from the ShareSync mirror.
# This script never touches production NAS data.
#
# Default test NAS paths:
#   Incoming mirror: /volume1/warehouse-system-test/data
#   Test project:    /volume1/docker/ddq-warehouse-system-test
#   Sandbox data:    /volume1/docker/ddq-warehouse-system-test/data-test

INCOMING_DATA="${INCOMING_DATA:-/volume1/warehouse-system-test/data}"
PROJECT_ROOT="${PROJECT_ROOT:-/volume1/docker/ddq-warehouse-system-test}"
SANDBOX_DATA="${SANDBOX_DATA:-$PROJECT_ROOT/data-test}"
TOOL_ROOT="${TOOL_ROOT:-$PROJECT_ROOT/sandbox-tools}"
BACKUP_ROOT="${BACKUP_ROOT:-$PROJECT_ROOT/backups/sandbox-reset}"
DB_NAME="${DB_NAME:-warehouse.db}"
TEST_CONTAINER="${TEST_CONTAINER:-warehouse-system-test}"
DOCKER_BIN="${DOCKER_BIN:-/usr/local/bin/docker}"
RESTART_CONTAINER="${RESTART_CONTAINER:-auto}"
LOG_DIR="$TOOL_ROOT/logs"
LOG_FILE="$LOG_DIR/reset-sandbox.log"

umask 0002
mkdir -p "$LOG_DIR" "$BACKUP_ROOT" "$PROJECT_ROOT"

log() {
  printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_FILE"
}

can_use_docker() {
  [ -x "$DOCKER_BIN" ] && "$DOCKER_BIN" ps >/dev/null 2>&1
}

container_exists() {
  can_use_docker && "$DOCKER_BIN" inspect "$TEST_CONTAINER" >/dev/null 2>&1
}

container_running() {
  [ "$("$DOCKER_BIN" inspect -f '{{.State.Running}}' "$TEST_CONTAINER" 2>/dev/null || true)" = "true" ]
}

if [ ! -d "$INCOMING_DATA" ]; then
  log "ERROR incoming data dir not found: $INCOMING_DATA"
  exit 1
fi

if [ ! -f "$INCOMING_DATA/$DB_NAME" ]; then
  log "ERROR incoming database not found: $INCOMING_DATA/$DB_NAME"
  exit 1
fi

log "reset start"
log "incoming=$INCOMING_DATA"
log "sandbox=$SANDBOX_DATA"

# Avoid copying a partially synced mirror.
sqlite3 "$INCOMING_DATA/$DB_NAME" 'PRAGMA integrity_check;' | grep -qx 'ok'

WAS_RUNNING=0
if [ "$RESTART_CONTAINER" != "0" ] && container_exists; then
  if container_running; then
    WAS_RUNNING=1
    log "stop test container: $TEST_CONTAINER"
    "$DOCKER_BIN" stop "$TEST_CONTAINER" >/dev/null
  else
    log "test container exists but is not running: $TEST_CONTAINER"
  fi
elif [ "$RESTART_CONTAINER" = "1" ]; then
  log "ERROR docker not available or container not found: $TEST_CONTAINER"
  exit 1
else
  log "docker not available or container not found, reset data without container restart"
fi

STAMP=$(date '+%Y%m%d-%H%M%S')
if [ -d "$SANDBOX_DATA" ] && [ "$(find "$SANDBOX_DATA" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]; then
  BACKUP_DIR="$BACKUP_ROOT/data-before-reset-$STAMP"
  log "backup old sandbox to $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
  rsync -a "$SANDBOX_DATA/" "$BACKUP_DIR/"
else
  log "no existing sandbox data to backup"
fi

# Replace sandbox with a clean copy from incoming mirror.
rm -rf "$SANDBOX_DATA"
mkdir -p "$SANDBOX_DATA"
rsync -a --delete "$INCOMING_DATA/" "$SANDBOX_DATA/"

# SQLite runtime files must be recreated by the test app, not copied from the mirror.
rm -f "$SANDBOX_DATA/$DB_NAME-wal" "$SANDBOX_DATA/$DB_NAME-shm" "$SANDBOX_DATA/$DB_NAME.tmp"

sqlite3 "$SANDBOX_DATA/$DB_NAME" 'PRAGMA integrity_check;' | grep -qx 'ok'

find "$SANDBOX_DATA" -type d -exec chmod 777 {} +
find "$SANDBOX_DATA" -type f -exec chmod 666 {} +

if [ "$WAS_RUNNING" = "1" ]; then
  log "start test container: $TEST_CONTAINER"
  "$DOCKER_BIN" start "$TEST_CONTAINER" >/dev/null
fi

DB_SIZE=$(stat -c %s "$SANDBOX_DATA/$DB_NAME" 2>/dev/null || ls -l "$SANDBOX_DATA/$DB_NAME" | awk '{print $5}')
UPLOAD_COUNT=$(find "$SANDBOX_DATA/uploads" -type f 2>/dev/null | wc -l | tr -d ' ')
cat > "$TOOL_ROOT/latest-reset-meta.json" <<EOF
{
  "resetAt": "$(date -Iseconds)",
  "incomingData": "$INCOMING_DATA",
  "sandboxData": "$SANDBOX_DATA",
  "database": "$DB_NAME",
  "databaseBytes": $DB_SIZE,
  "uploadFileCount": $UPLOAD_COUNT
}
EOF
chmod 664 "$TOOL_ROOT/latest-reset-meta.json"

log "reset complete db_bytes=$DB_SIZE upload_files=$UPLOAD_COUNT"
