#!/bin/sh
set -eu

# Reset test NAS sandbox from the ShareSync mirror.
# This script never touches production NAS data.
#
# Default test NAS paths:
#   Incoming mirror: /volume1/warehouse-system-test/data
#   Test project:    /volume1/docker/ddq-warehouse-system-test
#   Actual sandbox:  /volume1/docker/ddq-warehouse-system-test/data-test
#   Friendly alias:  /volume1/docker/ddq-warehouse-system-test/data -> data-test

INCOMING_DATA="${INCOMING_DATA:-/volume1/warehouse-system-test/data}"
PROJECT_ROOT="${PROJECT_ROOT:-/volume1/docker/ddq-warehouse-system-test}"
SANDBOX_DATA="${SANDBOX_DATA:-$PROJECT_ROOT/data-test}"
SANDBOX_ALIAS="${SANDBOX_ALIAS:-$PROJECT_ROOT/data}"
TOOL_ROOT="${TOOL_ROOT:-$PROJECT_ROOT/sandbox-tools}"
BACKUP_ROOT="${BACKUP_ROOT:-$PROJECT_ROOT/backups/sandbox-reset}"
DB_NAME="${DB_NAME:-warehouse.db}"
LOG_DIR="$TOOL_ROOT/logs"
LOG_FILE="$LOG_DIR/reset-sandbox.log"

umask 0002
mkdir -p "$LOG_DIR" "$BACKUP_ROOT" "$PROJECT_ROOT"

log() {
  printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_FILE"
}

if [ ! -d "$INCOMING_DATA" ]; then
  log "ERROR incoming data dir not found: $INCOMING_DATA"
  exit 1
fi

if [ ! -f "$INCOMING_DATA/$DB_NAME" ]; then
  log "ERROR incoming database not found: $INCOMING_DATA/$DB_NAME"
  exit 1
fi

if [ -e "$SANDBOX_ALIAS" ] && [ ! -L "$SANDBOX_ALIAS" ]; then
  log "ERROR sandbox alias exists but is not a symlink: $SANDBOX_ALIAS"
  log "Refusing to overwrite it. Please inspect manually."
  exit 1
fi

log "reset start"
log "incoming=$INCOMING_DATA"
log "sandbox=$SANDBOX_DATA"

# Avoid copying a partially synced mirror.
sqlite3 "$INCOMING_DATA/$DB_NAME" 'PRAGMA integrity_check;' | grep -qx 'ok'

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

# Make the user-facing path /data point to the actual compose-mounted data-test folder.
ln -sfn "data-test" "$SANDBOX_ALIAS"

find "$SANDBOX_DATA" -type d -exec chmod 777 {} +
find "$SANDBOX_DATA" -type f -exec chmod 666 {} +

DB_SIZE=$(stat -c %s "$SANDBOX_DATA/$DB_NAME" 2>/dev/null || ls -l "$SANDBOX_DATA/$DB_NAME" | awk '{print $5}')
UPLOAD_COUNT=$(find "$SANDBOX_DATA/uploads" -type f 2>/dev/null | wc -l | tr -d ' ')
cat > "$TOOL_ROOT/latest-reset-meta.json" <<EOF
{
  "resetAt": "$(date -Iseconds)",
  "incomingData": "$INCOMING_DATA",
  "sandboxData": "$SANDBOX_DATA",
  "sandboxAlias": "$SANDBOX_ALIAS",
  "database": "$DB_NAME",
  "databaseBytes": $DB_SIZE,
  "uploadFileCount": $UPLOAD_COUNT
}
EOF
chmod 664 "$TOOL_ROOT/latest-reset-meta.json"

log "reset complete db_bytes=$DB_SIZE upload_files=$UPLOAD_COUNT"
