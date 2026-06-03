#!/usr/bin/env bash
set -euo pipefail

# One-command production NAS rollback.
# Restores the previous release recorded by deploy-nas-production.sh.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$HOME/Desktop/pass/.env}"
NAS_DIR="${NAS_PROD_DIR:-/volume1/docker/warehouse-system}"
NAS_PORT_DEFAULT="22"
DRY_RUN=0

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

NAS_HOST="${NAS_PROD_HOST:-}"
NAS_PORT="${NAS_PROD_PORT:-$NAS_PORT_DEFAULT}"
NAS_USER="${NAS_PROD_USER:-}"
NAS_PASSWORD="${NAS_PROD_PASSWORD:-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[生产回滚] 缺少本机命令：$1" >&2
    exit 1
  fi
}

redact_output() {
  perl -pe '
    BEGIN {
      @r = grep { defined && length } (
        $ENV{NAS_HOST}, $ENV{NAS_PORT}, $ENV{NAS_USER},
        $ENV{NAS_PASSWORD}, $ENV{NAS_DIR}
      );
    }
    for $x (@r) { s/\Q$x\E/[REDACTED]/g }
    s#https?://[^[:space:]]+#http://[REDACTED]#g;
    s#ssh [^[:space:]]+#ssh [REDACTED]#g;
  '
}

expect_ssh() {
  local remote_cmd="$1"
  REMOTE_CMD="$remote_cmd" expect <<'EXPECT'
set timeout 1800
spawn ssh -tt -p $env(NAS_PORT) -o StrictHostKeyChecking=no -o ConnectTimeout=15 -- "$env(NAS_USER)@$env(NAS_HOST)" $env(REMOTE_CMD)
expect {
  -re "(?i)are you sure.*yes/no" { send -- "yes\r"; exp_continue }
  -re "(?i).*assword:" { send -- "$env(NAS_PASSWORD)\r"; exp_continue }
  timeout { exit 124 }
  eof {}
}
catch wait result
exit [lindex $result 3]
EXPECT
}

expect_scp() {
  local source_file="$1"
  local target_file="$2"
  SOURCE_FILE="$source_file" TARGET_FILE="$target_file" expect <<'EXPECT'
set timeout 900
spawn scp -O -P $env(NAS_PORT) -o StrictHostKeyChecking=no -o ConnectTimeout=15 -- $env(SOURCE_FILE) "$env(NAS_USER)@$env(NAS_HOST):$env(TARGET_FILE)"
expect {
  -re "(?i)are you sure.*yes/no" { send -- "yes\r"; exp_continue }
  -re "(?i).*assword:" { send -- "$env(NAS_PASSWORD)\r"; exp_continue }
  timeout { exit 124 }
  eof {}
}
catch wait result
exit [lindex $result 3]
EXPECT
}

cd "$ROOT"
require_cmd expect
require_cmd perl
require_cmd mktemp

if [[ -z "$NAS_HOST" || -z "$NAS_USER" || -z "$NAS_PASSWORD" ]]; then
  echo "[生产回滚] 缺少生产 NAS 环境变量，请检查本机 ENV_FILE。" >&2
  exit 1
fi

export NAS_HOST NAS_PORT NAS_USER NAS_PASSWORD NAS_DIR

ROLLBACK_ID="$(date '+%Y%m%d-%H%M%S')"
REMOTE_SCRIPT="/tmp/warehouse-system-rollback-${ROLLBACK_ID}.sh"
LOCAL_REMOTE_SCRIPT="$(mktemp "/tmp/warehouse-system-remote-rollback.XXXXXX")"

cleanup() {
  rm -f "$LOCAL_REMOTE_SCRIPT"
}
trap cleanup EXIT

cat > "$LOCAL_REMOTE_SCRIPT" <<'REMOTE_SCRIPT'
#!/bin/sh
set -eu

log() {
  printf '%s %s\n' "$(date '+%F %T')" "$*"
}

compose_cmd() {
  if command -v docker-compose >/dev/null 2>&1; then
    printf '%s\n' "docker-compose"
  elif [ -x /usr/local/bin/docker-compose ]; then
    printf '%s\n' "/usr/local/bin/docker-compose"
  elif docker compose version >/dev/null 2>&1; then
    printf '%s\n' "docker compose"
  else
    log "ERROR docker compose command not found"
    exit 1
  fi
}

run_compose() {
  cmd="$(compose_cmd)"
  if [ "$(id -u)" -eq 0 ]; then
    HOME=/tmp sh -c "$cmd $*"
  else
    HOME=/tmp sudo -S sh -c "$cmd $*"
  fi
}

health_check() {
  i=1
  while [ "$i" -le 30 ]; do
    if curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    i=$((i + 1))
  done
  return 1
}

: "${PROD_ROOT:?missing PROD_ROOT}"
DATA_DIR="$PROD_ROOT/data"
CURRENT_FILE="$PROD_ROOT/current-release"
PREVIOUS_FILE="$PROD_ROOT/previous-release"

if [ ! -f "$PREVIOUS_FILE" ]; then
  log "ERROR previous release marker not found"
  exit 1
fi

CURRENT_RELEASE=""
if [ -f "$CURRENT_FILE" ]; then
  CURRENT_RELEASE="$(cat "$CURRENT_FILE")"
fi
TARGET_RELEASE="$(cat "$PREVIOUS_FILE")"

if [ -z "$TARGET_RELEASE" ] || [ ! -f "$TARGET_RELEASE/docker-compose.yml" ]; then
  log "ERROR previous release is not deployable: $TARGET_RELEASE"
  exit 1
fi

if [ ! -d "$DATA_DIR" ]; then
  log "ERROR production data dir missing: $DATA_DIR"
  exit 1
fi

if [ -f "$DATA_DIR/warehouse.db" ] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA_DIR/warehouse.db" 'PRAGMA integrity_check;' | grep -qx 'ok'
  log "production database integrity ok before rollback"
fi

log "rolling back from $CURRENT_RELEASE to $TARGET_RELEASE"
if [ -n "$CURRENT_RELEASE" ] && [ -d "$CURRENT_RELEASE" ] && [ "$CURRENT_RELEASE" != "$TARGET_RELEASE" ]; then
  log "stopping current release before rollback"
  cd "$CURRENT_RELEASE"
  run_compose -f docker-compose.yml down || true
fi

cd "$TARGET_RELEASE"
run_compose -f docker-compose.yml up -d --build
health_check

if [ -f "$DATA_DIR/warehouse.db" ] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA_DIR/warehouse.db" 'PRAGMA integrity_check;' | grep -qx 'ok'
  log "production database integrity ok after rollback"
fi

printf '%s\n' "$TARGET_RELEASE" > "$CURRENT_FILE"
if [ -n "$CURRENT_RELEASE" ]; then
  printf '%s\n' "$CURRENT_RELEASE" > "$PREVIOUS_FILE"
fi

log "production rollback complete"
REMOTE_SCRIPT

chmod 700 "$LOCAL_REMOTE_SCRIPT"

if [[ "$DRY_RUN" == "1" ]]; then
  grep -Eq 'previous-release' "$LOCAL_REMOTE_SCRIPT"
  grep -Eq 'warehouse\.db' "$LOCAL_REMOTE_SCRIPT"
  if grep -Eq 'rm -rf|rsync --delete|/data/warehouse\.db.*rm' "$LOCAL_REMOTE_SCRIPT"; then
    echo "[生产回滚] dry-run 失败：远端回滚脚本包含危险删除逻辑。" >&2
    exit 1
  fi
  echo "[生产回滚] dry-run 通过：回滚脚本只切换上一版本并保留生产 data。"
  echo "[生产回滚] dry-run 未连接生产 NAS，也未修改远端。"
  exit 0
fi

echo "[生产回滚] 上传远端回滚脚本..."
expect_scp "$LOCAL_REMOTE_SCRIPT" "$REMOTE_SCRIPT" 2>&1 | redact_output

echo "[生产回滚] 开始回滚到上一生产版本..."
expect_ssh "PROD_ROOT='${NAS_DIR}' sh '${REMOTE_SCRIPT}'; rc=\$?; rm -f '${REMOTE_SCRIPT}'; exit \$rc" 2>&1 | redact_output

echo "[生产回滚] 完成。"
