# 旧 NAS-B 方案归档

这个目录存放旧的“NAS-B / 办公室端”部署方案，当前不再作为主部署方案使用。

当前统一命名：

- 部署 A / NAS-A / 生产端：使用根目录 `docker-compose.yml`
- 部署 B / NAS-B / 测试端：使用根目录 `docker-compose.test-nas.yml`，通过 `scripts/deploy-nas-test.sh` 部署到 `192.168.31.89:3010`

归档文件：

- `docker-compose.nasb.yml`：旧办公室端 compose 配置
- `NAS-B-legacy-guide.md`：旧 NAS-B 部署说明

除非明确要恢复旧办公室端方案，否则不要使用本目录里的配置部署。
