#!/bin/sh
set -eu

# Warehouse production snapshot script.
# Purpose:
#   Safely copy production runtime data into a ShareSync source folder.
#   The production application does NOT need to stop.
#
# Default production NAS paths:
#   Runtime data:  /volume1/docker/warehouse-system/data
#   Snapshot data: /volume1/warehouse-system/data
#   Tool/log dir:  /volume1/docker/warehouse-system-snapshot-tools
#
# Override paths via env vars if needed:
#   SRC_DATA=/path/to/runtime/data SNAP_DATA=/path/to/snapshot/data TOOL_ROOT=/path/to/tools ./create-production-snapshot.sh

SRC_DATA="${SRC_DATA:-/volume1/docker/warehouse-system/data}"
SNAP_DATA="${SNAP_DATA:-/volume1/warehouse-system/data}"
TOOL_ROOT="${TOOL_ROOT:-/volume1/docker/warehouse-system-snapshot-tools}"
DB_NAME="${DB_NAME:-warehouse.db}"

SRC_DB="$SRC_DATA/$DB_NAME"
DST_DB="$SNAP_DATA/$DB_NAME"
TMP_DB="$SNAP_DATA/$DB_NAME.tmp"
META_TMP="$TOOL_ROOT/latest-snapshot-meta.json.tmp"
META="$TOOL_ROOT/latest-snapshot-meta.json"
LOG_DIR="$TOOL_ROOT/logs"
LOG_FILE="$LOG_DIR/snapshot.log"

umask 0002
mkdir -p "$SNAP_DATA" "$LOG_DIR"

log() {
  printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_FILE"
}

if [ ! -d "$SRC_DATA" ]; then
  log "ERROR source data dir not found: $SRC_DATA"
  exit 1
fi

if [ ! -f "$SRC_DB" ]; then
  log "ERROR source db not found: $SRC_DB"
  exit 1
fi

log "snapshot start"
log "source=$SRC_DATA"
log "target=$SNAP_DATA"

# Mirror non-database files. This is read-only for production data.
# SQLite live files are excluded because the database is copied via `.backup` below.
rsync -a --delete \
  --exclude="/$DB_NAME" \
  --exclude="/$DB_NAME-wal" \
  --exclude="/$DB_NAME-shm" \
  --exclude="/$DB_NAME.tmp" \
  "$SRC_DATA/" "$SNAP_DATA/"

# Create a consistent SQLite backup while production keeps running.
rm -f "$TMP_DB"
sqlite3 "$SRC_DB" ".backup '$TMP_DB'"
sqlite3 "$TMP_DB" 'PRAGMA integrity_check;' | grep -qx 'ok'
mv -f "$TMP_DB" "$DST_DB"
chmod 666 "$DST_DB"

# Mirror non-database files once more to catch uploads created during DB backup.
rsync -a --delete \
  --exclude="/$DB_NAME" \
  --exclude="/$DB_NAME-wal" \
  --exclude="/$DB_NAME-shm" \
  --exclude="/$DB_NAME.tmp" \
  "$SRC_DATA/" "$SNAP_DATA/"

# Keep the snapshot folder readable by Synology Drive ShareSync.
# This only touches the snapshot copy, never the production data folder.
find "$SNAP_DATA" -type d -exec chmod 777 {} +
find "$SNAP_DATA" -type f -exec chmod 666 {} +

# Keep metadata outside the ShareSync folder so /volume1/warehouse-system stays clean.
DB_SIZE=$(stat -c %s "$DST_DB" 2>/dev/null || ls -l "$DST_DB" | awk '{print $5}')
UPLOAD_COUNT=$(find "$SNAP_DATA/uploads" -type f 2>/dev/null | wc -l | tr -d ' ')
CREATED_AT=$(date -Iseconds)
cat > "$META_TMP" <<EOF
{
  "createdAt": "$CREATED_AT",
  "sourceData": "$SRC_DATA",
  "snapshotData": "$SNAP_DATA",
  "database": "$DB_NAME",
  "databaseBytes": $DB_SIZE,
  "uploadFileCount": $UPLOAD_COUNT,
  "method": "sqlite_backup_plus_rsync_delete",
  "productionStopped": false
}
EOF
mv -f "$META_TMP" "$META"
chmod 664 "$META"

log "snapshot complete db_bytes=$DB_SIZE upload_files=$UPLOAD_COUNT"
