#!/bin/sh
set -eu

TOOL_ROOT="${TOOL_ROOT:-/volume1/docker/warehouse-system-snapshot-tools}"
SNAPSHOT_SCRIPT="$TOOL_ROOT/create-snapshot.sh"
LOCK_DIR="$TOOL_ROOT/snapshot.lock"
LOG_FILE="$TOOL_ROOT/logs/cron.log"

mkdir -p "$TOOL_ROOT/logs"

if mkdir "$LOCK_DIR" 2>/dev/null; then
  trap 'rmdir "$LOCK_DIR"' EXIT INT TERM
else
  printf '%s previous snapshot still running, skip\n' "$(date '+%F %T')" >> "$LOG_FILE"
  exit 0
fi

printf '%s cron snapshot start\n' "$(date '+%F %T')" >> "$LOG_FILE"
if "$SNAPSHOT_SCRIPT" >> "$LOG_FILE" 2>&1; then
  printf '%s cron snapshot ok\n' "$(date '+%F %T')" >> "$LOG_FILE"
else
  code=$?
  printf '%s cron snapshot failed exit=%s\n' "$(date '+%F %T')" "$code" >> "$LOG_FILE"
  exit "$code"
fi
