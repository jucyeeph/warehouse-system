#!/usr/bin/env bash
set -euo pipefail

# One-command production NAS deployment with automatic rollback.
# Secrets are loaded from a local env file and are never written into this repo.
#
# Required env vars, normally from $HOME/Desktop/pass/.env:
#   NAS_PROD_HOST, NAS_PROD_USER, NAS_PROD_PASSWORD
# Optional:
#   NAS_PROD_PORT, NAS_PROD_DIR, ENV_FILE, SKIP_TESTS=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$HOME/Desktop/pass/.env}"
NAS_DIR="${NAS_PROD_DIR:-/volume1/docker/warehouse-system}"
NAS_PORT_DEFAULT="22"
COMPOSE_FILE="docker-compose.yml"
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
    echo "[生产部署] 缺少本机命令：$1" >&2
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

cd "$ROOT"

require_cmd git
require_cmd tar
require_cmd perl
require_cmd mktemp

if [[ -z "$NAS_HOST" || -z "$NAS_USER" || -z "$NAS_PASSWORD" ]]; then
  echo "[生产部署] 缺少生产 NAS 环境变量，请检查本机 ENV_FILE。" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[生产部署] 工作区有未提交修改。请先提交，确保生产部署可追溯。" >&2
  exit 1
fi

if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "[生产部署] 工作区有未跟踪文件。请先提交或移走它们。" >&2
  exit 1
fi

if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  require_cmd npm
  echo "[生产部署] 运行本地后端测试..."
  npm --prefix server test
fi

SHORT_SHA="$(git rev-parse --short HEAD)"
RELEASE_ID="$(date '+%Y%m%d-%H%M%S')-${SHORT_SHA}"
ARCHIVE_NAME="warehouse-system-prod-${RELEASE_ID}.tar.gz"
LOCAL_ARCHIVE="/tmp/${ARCHIVE_NAME}"
REMOTE_ARCHIVE="/tmp/${ARCHIVE_NAME}"
REMOTE_SCRIPT="/tmp/warehouse-system-deploy-${RELEASE_ID}.sh"
LOCAL_REMOTE_SCRIPT="$(mktemp "/tmp/warehouse-system-remote-deploy.XXXXXX")"

cleanup() {
  rm -f "$LOCAL_ARCHIVE" "$LOCAL_REMOTE_SCRIPT"
}
trap cleanup EXIT

echo "[生产部署] 打包当前提交 ${SHORT_SHA}..."
tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='server/node_modules' \
  --exclude='data' \
  --exclude='data-test' \
  --exclude='.DS_Store' \
  -czf "$LOCAL_ARCHIVE" \
  README.md .gitignore docker-compose.yml docker-compose.test-nas.yml public server scripts docs archive

if [[ "$DRY_RUN" == "1" ]]; then
  tar -tzf "$LOCAL_ARCHIVE" | grep -Eq '^docker-compose\.yml$'
  tar -tzf "$LOCAL_ARCHIVE" | grep -Eq '^server/server\.js$'
  if tar -tzf "$LOCAL_ARCHIVE" | grep -Eq '(^|/)data(/|$)|warehouse\.db'; then
    echo "[生产部署] dry-run 失败：部署包包含生产数据路径。" >&2
    exit 1
  fi
  echo "[生产部署] dry-run 通过：部署包不包含 data 或数据库文件。"
  echo "[生产部署] dry-run 未连接生产 NAS，也未修改远端。"
  exit 0
fi

require_cmd expect
export NAS_HOST NAS_PORT NAS_USER NAS_PASSWORD NAS_DIR

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

rollback_to() {
  target="$1"
  if [ -z "$target" ] || [ ! -f "$target/docker-compose.yml" ]; then
    log "ERROR rollback target is not deployable: $target"
    return 1
  fi
  if [ -n "${RELEASE_DIR:-}" ] && [ -d "$RELEASE_DIR" ] && [ "$RELEASE_DIR" != "$target" ]; then
    log "stopping failed release before rollback"
    cd "$RELEASE_DIR"
    run_compose -f docker-compose.yml down || true
  fi
  log "rolling back to $target"
  cd "$target"
  run_compose -f docker-compose.yml up -d --build
  health_check
}

backup_production_data() {
  data_backup_dir="$1/data"
  mkdir -p "$data_backup_dir"

  if [ ! -d "$DATA_DIR" ]; then
    log "ERROR production data dir missing: $DATA_DIR"
    exit 1
  fi

  if [ -f "$DATA_DIR/warehouse.db" ]; then
    if ! command -v sqlite3 >/dev/null 2>&1; then
      log "ERROR sqlite3 is required to create a safe production database backup"
      exit 1
    fi
    sqlite3 "$DATA_DIR/warehouse.db" 'PRAGMA integrity_check;' | grep -qx 'ok'
    sqlite3 "$DATA_DIR/warehouse.db" ".backup '$data_backup_dir/warehouse.db'"
    sqlite3 "$data_backup_dir/warehouse.db" 'PRAGMA integrity_check;' | grep -qx 'ok'
    log "production database backed up and verified"
  else
    log "WARN production database not found before deploy"
  fi

  for item in uploads thumbnails; do
    if [ -e "$DATA_DIR/$item" ]; then
      cp -a "$DATA_DIR/$item" "$data_backup_dir/"
    fi
  done

  {
    printf 'release=%s\n' "$RELEASE_ID"
    printf 'source_data=%s\n' "$DATA_DIR"
    printf 'backup_data=%s\n' "$data_backup_dir"
    printf 'created_at=%s\n' "$(date '+%F %T')"
    find "$data_backup_dir" -maxdepth 2 -type f 2>/dev/null | wc -l | awk '{print "file_count="$1}'
  } > "$data_backup_dir/backup-manifest.txt"
}

: "${PROD_ROOT:?missing PROD_ROOT}"
: "${RELEASE_ID:?missing RELEASE_ID}"
: "${REMOTE_ARCHIVE:?missing REMOTE_ARCHIVE}"

DATA_DIR="$PROD_ROOT/data"
RELEASES_DIR="$PROD_ROOT/releases"
BACKUP_DIR="$PROD_ROOT/backups/deploy-before-$RELEASE_ID"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
CURRENT_FILE="$PROD_ROOT/current-release"
PREVIOUS_FILE="$PROD_ROOT/previous-release"

log "production deploy start release=$RELEASE_ID"
mkdir -p "$PROD_ROOT" "$DATA_DIR" "$RELEASES_DIR" "$BACKUP_DIR"

backup_production_data "$BACKUP_DIR"

if [ -f "$CURRENT_FILE" ]; then
  PREVIOUS_RELEASE="$(cat "$CURRENT_FILE")"
elif [ -f "$PROD_ROOT/docker-compose.yml" ]; then
  PREVIOUS_RELEASE="$PROD_ROOT"
else
  PREVIOUS_RELEASE=""
fi

if [ -n "$PREVIOUS_RELEASE" ] && [ -d "$PREVIOUS_RELEASE" ]; then
  printf '%s\n' "$PREVIOUS_RELEASE" > "$PREVIOUS_FILE"
  for item in docker-compose.yml public server scripts docs archive README.md .gitignore; do
    if [ -e "$PREVIOUS_RELEASE/$item" ]; then
      cp -a "$PREVIOUS_RELEASE/$item" "$BACKUP_DIR/"
    fi
  done
fi

rm -rf "$RELEASE_DIR.tmp"
mkdir -p "$RELEASE_DIR.tmp"
tar -xzf "$REMOTE_ARCHIVE" -C "$RELEASE_DIR.tmp"
rm -f "$REMOTE_ARCHIVE"
rm -rf "$RELEASE_DIR"
mv "$RELEASE_DIR.tmp" "$RELEASE_DIR"
rm -rf "$RELEASE_DIR/data"
ln -s "$DATA_DIR" "$RELEASE_DIR/data"

if [ ! -f "$RELEASE_DIR/docker-compose.yml" ] || [ ! -f "$RELEASE_DIR/server/server.js" ]; then
  log "ERROR release is missing required files"
  exit 1
fi

log "building release before switching container"
cd "$RELEASE_DIR"
if ! run_compose -f docker-compose.yml build; then
  log "build failed; production container was not switched"
  exit 1
fi

log "starting release"
if [ -n "$PREVIOUS_RELEASE" ] && [ -f "$PREVIOUS_RELEASE/docker-compose.yml" ]; then
  log "stopping previous release before container switch"
  cd "$PREVIOUS_RELEASE"
  run_compose -f docker-compose.yml down
  cd "$RELEASE_DIR"
fi

if ! run_compose -f docker-compose.yml up -d; then
  log "start failed; attempting rollback"
  rollback_to "$PREVIOUS_RELEASE"
  exit 1
fi

if ! health_check; then
  log "health check failed; attempting rollback"
  rollback_to "$PREVIOUS_RELEASE"
  exit 1
fi

if [ -f "$DATA_DIR/warehouse.db" ] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA_DIR/warehouse.db" 'PRAGMA integrity_check;' | grep -qx 'ok'
  log "production database integrity ok after deploy"
fi

printf '%s\n' "$RELEASE_DIR" > "$CURRENT_FILE"
log "production deploy complete release=$RELEASE_ID"
REMOTE_SCRIPT

chmod 700 "$LOCAL_REMOTE_SCRIPT"

echo "[生产部署] 上传部署包和远端执行脚本..."
expect_scp "$LOCAL_ARCHIVE" "$REMOTE_ARCHIVE" 2>&1 | redact_output
expect_scp "$LOCAL_REMOTE_SCRIPT" "$REMOTE_SCRIPT" 2>&1 | redact_output

echo "[生产部署] 执行生产部署；失败会自动回滚到上一版本..."
expect_ssh "PROD_ROOT='${NAS_DIR}' RELEASE_ID='${RELEASE_ID}' REMOTE_ARCHIVE='${REMOTE_ARCHIVE}' sh '${REMOTE_SCRIPT}'; rc=\$?; rm -f '${REMOTE_SCRIPT}'; exit \$rc" 2>&1 | redact_output

echo "[生产部署] 完成。"
