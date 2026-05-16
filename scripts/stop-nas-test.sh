#!/usr/bin/env bash
set -euo pipefail

# 停止部署 B：个人 NAS 测试端
# 用法：NAS_PASSWORD='你的NAS密码' ./scripts/stop-nas-test.sh

NAS_HOST="${NAS_HOST:-192.168.31.89}"
NAS_USER="${NAS_USER:-openclawtest}"
NAS_DIR="${NAS_DIR:-/volume1/docker/ddq-warehouse-system-test}"
COMPOSE_FILE="docker-compose.test-nas.yml"

if [[ -z "${NAS_PASSWORD:-}" ]]; then
  echo "[部署B] 缺少 NAS_PASSWORD。用法：NAS_PASSWORD='你的NAS密码' ./scripts/stop-nas-test.sh" >&2
  exit 1
fi

if ! command -v sshpass >/dev/null 2>&1; then
  echo "[部署B] 本机缺少 sshpass，无法自动输入 SSH 密码。" >&2
  exit 1
fi

echo "[部署B] 停止 Docker 测试端。NAS 会要求输入 sudo 密码；请输入你的 NAS 密码。"
sshpass -p "$NAS_PASSWORD" ssh -tt -o StrictHostKeyChecking=no -o ConnectTimeout=15 "${NAS_USER}@${NAS_HOST}" "cd '${NAS_DIR}' && sudo /usr/local/bin/docker-compose -f '${COMPOSE_FILE}' down"

echo "[部署B] 个人 NAS 测试端已停止：${NAS_HOST}:3010"
