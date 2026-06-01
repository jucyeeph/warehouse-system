#!/usr/bin/env bash
set -euo pipefail

# Deploy to the NAS test environment.
# Connection details must come from environment variables or a local .env file.
#
# Supported variables:
#   NAS_TEST_HOST / NAS_TEST_PORT / NAS_TEST_USER / NAS_TEST_PASSWORD
#   or NAS_HOST / NAS_PORT / NAS_USER / NAS_PASSWORD
#
# Optional:
#   NAS_DIR, ENV_FILE

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$HOME/Desktop/pass/.env}"
ARCHIVE_NAME="ddq-warehouse-system-test.tar.gz"
REMOTE_ARCHIVE="/tmp/${ARCHIVE_NAME}"
COMPOSE_FILE="docker-compose.test-nas.yml"
NAS_DIR="${NAS_DIR:-/volume1/docker/ddq-warehouse-system-test}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

NAS_HOST="${NAS_HOST:-${NAS_TEST_HOST:-}}"
NAS_PORT="${NAS_PORT:-${NAS_TEST_PORT:-22}}"
NAS_USER="${NAS_USER:-${NAS_TEST_USER:-}}"
NAS_PASSWORD="${NAS_PASSWORD:-${NAS_TEST_PASSWORD:-}}"

if [[ -z "$NAS_HOST" || -z "$NAS_USER" || -z "$NAS_PASSWORD" ]]; then
  echo "[部署B] 缺少测试 NAS 环境变量。请检查本机 .env 文件。" >&2
  exit 1
fi
export NAS_HOST NAS_PORT NAS_USER NAS_PASSWORD NAS_DIR

if ! command -v expect >/dev/null 2>&1; then
  echo "[部署B] 本机缺少 expect，无法自动执行 SSH 部署。" >&2
  exit 1
fi

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
set timeout -1
spawn scp -P $env(NAS_PORT) -o StrictHostKeyChecking=no -o ConnectTimeout=15 -- $env(SOURCE_FILE) "$env(NAS_USER)@$env(NAS_HOST):$env(TARGET_FILE)"
expect {
  -re "(?i)are you sure.*yes/no" { send -- "yes\r"; exp_continue }
  -re "(?i)password:" { send -- "$env(NAS_PASSWORD)\r"; exp_continue }
  eof
}
catch wait result
exit [lindex $result 3]
EXPECT
}

expect_ssh() {
  local remote_cmd="$1"
  REMOTE_CMD="$remote_cmd" expect <<'EXPECT'
set timeout -1
spawn ssh -tt -p $env(NAS_PORT) -o StrictHostKeyChecking=no -o ConnectTimeout=15 -- "$env(NAS_USER)@$env(NAS_HOST)" $env(REMOTE_CMD)
expect {
  -re "(?i)are you sure.*yes/no" { send -- "yes\r"; exp_continue }
  -re "(?i)password:" { send -- "$env(NAS_PASSWORD)\r"; exp_continue }
  eof
}
catch wait result
exit [lindex $result 3]
EXPECT
}

cd "$ROOT"

echo "[部署B] 打包项目代码..."
tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='server/node_modules' \
  --exclude='data' \
  --exclude='data-test' \
  --exclude='.DS_Store' \
  -czf "/tmp/${ARCHIVE_NAME}" \
  README.md .gitignore docker-compose.yml docker-compose.test-nas.yml public server scripts docs archive 2>/dev/null || \
tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='server/node_modules' \
  --exclude='data' \
  --exclude='data-test' \
  --exclude='.DS_Store' \
  -czf "/tmp/${ARCHIVE_NAME}" \
  README.md .gitignore docker-compose.yml docker-compose.test-nas.yml public server scripts

echo "[部署B] 上传到测试 NAS..."
expect_scp "/tmp/${ARCHIVE_NAME}" "${REMOTE_ARCHIVE}" 2>&1 | redact_output
rm -f "/tmp/${ARCHIVE_NAME}"

echo "[部署B] 解压代码..."
expect_ssh "
set -e
mkdir -p '${NAS_DIR}'
cd '${NAS_DIR}'
tar -xzf '${REMOTE_ARCHIVE}'
rm -f '${REMOTE_ARCHIVE}'
mkdir -p data-test/uploads
" 2>&1 | redact_output

echo "[部署B] 启动 Docker 测试端..."
expect_ssh "
set -e
cd '${NAS_DIR}'
if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_BIN=\"\$(command -v docker-compose)\"
elif [ -x /usr/local/bin/docker-compose ]; then
  COMPOSE_BIN=/usr/local/bin/docker-compose
else
  COMPOSE_BIN=\"docker compose\"
fi
sudo \${COMPOSE_BIN} -f '${COMPOSE_FILE}' up -d --build
" 2>&1 | redact_output

echo "[部署B] 等待服务启动并检查健康状态..."
for _ in {1..20}; do
  if curl -fsS "http://${NAS_HOST}:3010/api/health" >/dev/null 2>&1; then
    echo "[部署B] 测试端部署成功。"
    echo "[部署B] 已通过健康检查。"
    exit 0
  fi
  sleep 3
done

echo "[部署B] 容器启动命令已执行，但健康检查暂未通过。请在 NAS 控制台检查测试端容器状态。" >&2
exit 1
