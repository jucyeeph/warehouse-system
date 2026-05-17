#!/usr/bin/env bash
set -euo pipefail

# 部署 B：部署到个人 NAS 测试端
# 目标：openclawtest@192.168.31.89:/volume1/docker/ddq-warehouse-system-test
# 访问：http://192.168.31.89:3010
#
# 用法：
#   NAS_PASSWORD='你的NAS密码' ./scripts/deploy-nas-test.sh
#
# 说明：NAS 上 Docker 需要 sudo 权限。脚本会自动上传和解压代码，
# 启动 docker-compose 时会打开交互式 sudo，按提示再输入一次 NAS 密码即可。
# 不要把 NAS_PASSWORD 写进仓库文件，只在命令行临时传入。

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAS_HOST="${NAS_HOST:-192.168.31.89}"
NAS_USER="${NAS_USER:-openclawtest}"
NAS_DIR="${NAS_DIR:-/volume1/docker/ddq-warehouse-system-test}"
ARCHIVE_NAME="ddq-warehouse-system-test.tar.gz"
REMOTE_ARCHIVE="/tmp/${ARCHIVE_NAME}"
COMPOSE_FILE="docker-compose.test-nas.yml"

if [[ -z "${NAS_PASSWORD:-}" ]]; then
  echo "[部署B] 缺少 NAS_PASSWORD。用法：NAS_PASSWORD='你的NAS密码' ./scripts/deploy-nas-test.sh" >&2
  exit 1
fi

if ! command -v sshpass >/dev/null 2>&1; then
  echo "[部署B] 本机缺少 sshpass，无法自动输入 SSH 密码。" >&2
  echo "可以先安装：brew install hudochenkov/sshpass/sshpass" >&2
  exit 1
fi

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

echo "[部署B] 上传到 NAS ${NAS_HOST}..."
SSHPASS="$NAS_PASSWORD" sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 "${NAS_USER}@${NAS_HOST}" "cat > '${REMOTE_ARCHIVE}'" < "/tmp/${ARCHIVE_NAME}"
rm -f "/tmp/${ARCHIVE_NAME}"

echo "[部署B] 解压代码..."
SSHPASS="$NAS_PASSWORD" sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 "${NAS_USER}@${NAS_HOST}" "
set -e
mkdir -p '${NAS_DIR}'
cd '${NAS_DIR}'
tar -xzf '${REMOTE_ARCHIVE}'
rm -f '${REMOTE_ARCHIVE}'
mkdir -p data-test/uploads
"

echo "[部署B] 启动 Docker 测试端。NAS 会要求输入 sudo 密码；请输入你的 NAS 密码。"
sshpass -p "$NAS_PASSWORD" ssh -tt -o StrictHostKeyChecking=no -o ConnectTimeout=15 "${NAS_USER}@${NAS_HOST}" "cd '${NAS_DIR}' && sudo /usr/local/bin/docker-compose -f '${COMPOSE_FILE}' up -d --build"

echo "[部署B] 等待服务启动并检查健康状态..."
for i in {1..20}; do
  if curl -fsS "http://${NAS_HOST}:3010/api/health" >/dev/null 2>&1; then
    echo "[部署B] 启动成功："
    echo "- 入口：http://${NAS_HOST}:3010"
    echo "- 员工端：http://${NAS_HOST}:3010/employee.html"
    echo "- 管理端：http://${NAS_HOST}:3010/admin.html"
    echo "- 数据目录：${NAS_DIR}/data-test"
    exit 0
  fi
  sleep 3
done

echo "[部署B] 容器已启动，但本机健康检查暂未通过。请在 NAS 上检查：" >&2
echo "ssh ${NAS_USER}@${NAS_HOST}" >&2
echo "cd ${NAS_DIR} && sudo /usr/local/bin/docker-compose -f ${COMPOSE_FILE} ps" >&2
exit 1
